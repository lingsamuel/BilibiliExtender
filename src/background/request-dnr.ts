import { ext } from '@/shared/platform/webext';

const DNR_RULE_PRIORITY = 10;
const DNR_ACTION_MODIFY_HEADERS = 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType;
const DNR_HEADER_OPERATION_SET = 'set' as chrome.declarativeNetRequest.HeaderOperation;
const DNR_REQUEST_METHOD_POST = 'post' as chrome.declarativeNetRequest.RequestMethod;
const DNR_RESOURCE_XMLHTTPREQUEST = 'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType;

const RULE_IDS = {
  follow: 10_001,
  like: 10_002,
  fav: 10_003
} as const;

let writeRequestChain: Promise<void> = Promise.resolve();

async function installRequestHeaderRule(options: {
  kind: keyof typeof RULE_IDS;
  pageOrigin: string;
  pageReferer: string;
  regexFilter: string;
}): Promise<number> {
  const safeOrigin = options.pageOrigin.trim();
  const safeReferer = options.pageReferer.trim();
  if (!safeOrigin || !safeReferer) {
    throw new Error('页面上下文不完整');
  }
  if (!ext.declarativeNetRequest?.updateSessionRules) {
    throw new Error('当前浏览器不支持 declarativeNetRequest');
  }

  const refererUrl = new URL(safeReferer);
  refererUrl.hash = '';
  const ruleId = RULE_IDS[options.kind];

  await ext.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: DNR_RULE_PRIORITY,
        action: {
          type: DNR_ACTION_MODIFY_HEADERS,
          requestHeaders: [
            {
              header: 'origin',
              operation: DNR_HEADER_OPERATION_SET,
              value: safeOrigin
            },
            {
              header: 'referer',
              operation: DNR_HEADER_OPERATION_SET,
              value: refererUrl.toString()
            },
            {
              header: 'sec-fetch-site',
              operation: DNR_HEADER_OPERATION_SET,
              value: 'same-site'
            }
          ]
        },
        condition: {
          regexFilter: options.regexFilter,
          requestMethods: [DNR_REQUEST_METHOD_POST],
          resourceTypes: [DNR_RESOURCE_XMLHTTPREQUEST]
        }
      }
    ]
  });

  return ruleId;
}

async function removeRule(ruleId: number): Promise<void> {
  if (!ext.declarativeNetRequest?.updateSessionRules) {
    return;
  }
  await ext.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId]
  });
}

/**
 * background 发起的写请求并不归属于某个页面 tab，不能依赖 tabIds 精确命中。
 * 这里改用“安装规则 -> 执行单次请求 -> 立即清理规则”的串行门，确保请求真正命中 DNR，
 * 同时避免多个写请求并发时互相污染来源头。
 */
async function runWithRequestHeaderRule<T>(
  options: {
    kind: keyof typeof RULE_IDS;
    pageOrigin: string;
    pageReferer: string;
    regexFilter: string;
  },
  task: () => Promise<T>
): Promise<T> {
  const prev = writeRequestChain.catch(() => undefined);
  let release!: () => void;
  writeRequestChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prev;

  let ruleId: number | null = null;
  try {
    ruleId = await installRequestHeaderRule(options);
    return await task();
  } finally {
    try {
      if (ruleId !== null) {
        await removeRule(ruleId);
      }
    } finally {
      release();
    }
  }
}

export async function runWithFollowRequestHeaders<T>(
  pageOrigin: string,
  pageReferer: string,
  task: () => Promise<T>
): Promise<T> {
  return runWithRequestHeaderRule(
    {
      kind: 'follow',
      pageOrigin,
      pageReferer,
      regexFilter: '^https://api\\.bilibili\\.com/x/relation/modify(\\?.*)?$'
    },
    task
  );
}

export async function runWithLikeRequestHeaders<T>(
  pageOrigin: string,
  pageReferer: string,
  task: () => Promise<T>
): Promise<T> {
  return runWithRequestHeaderRule(
    {
      kind: 'like',
      pageOrigin,
      pageReferer,
      regexFilter: '^https://api\\.bilibili\\.com/x/web-interface/archive/like(\\?.*)?$'
    },
    task
  );
}

export async function runWithFavRequestHeaders<T>(
  pageOrigin: string,
  pageReferer: string,
  task: () => Promise<T>
): Promise<T> {
  return runWithRequestHeaderRule(
    {
      kind: 'fav',
      pageOrigin,
      pageReferer,
      regexFilter: '^https://api\\.bilibili\\.com/x/v3/fav/resource/(deal|batch-del)(\\?.*)?$'
    },
    task
  );
}
