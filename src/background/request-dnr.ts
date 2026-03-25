import { ext } from '@/shared/platform/webext';

const DNR_RULE_PRIORITY = 10;
const RULE_ID_START = 10_000;
const DNR_ACTION_MODIFY_HEADERS = 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType;
const DNR_HEADER_OPERATION_SET = 'set' as chrome.declarativeNetRequest.HeaderOperation;
const DNR_REQUEST_METHOD_POST = 'post' as chrome.declarativeNetRequest.RequestMethod;
const DNR_RESOURCE_XMLHTTPREQUEST = 'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType;

const ruleIdByKey = new Map<string, number>();
const ruleKeysByTabId = new Map<number, Set<string>>();
let nextRuleId = RULE_ID_START;

function rememberRuleKey(tabId: number, ruleKey: string): void {
  const existing = ruleKeysByTabId.get(tabId) ?? new Set<string>();
  existing.add(ruleKey);
  ruleKeysByTabId.set(tabId, existing);
}

function allocateRuleId(kind: 'follow' | 'like', tabId: number): number {
  const ruleKey = `${kind}:${tabId}`;
  const existing = ruleIdByKey.get(ruleKey);
  if (existing) {
    return existing;
  }

  const ruleId = nextRuleId++;
  ruleIdByKey.set(ruleKey, ruleId);
  rememberRuleKey(tabId, ruleKey);
  return ruleId;
}

/**
 * 安装“仅命中当前标签页”的 DNR 规则，避免多个标签页串用同一组来源头。
 */
async function installRequestHeaderRule(options: {
  kind: 'follow' | 'like';
  tabId: number;
  pageOrigin: string;
  pageReferer: string;
  regexFilter: string;
}): Promise<void> {
  const safeOrigin = options.pageOrigin.trim();
  const safeReferer = options.pageReferer.trim();
  if (!safeOrigin || !safeReferer) {
    throw new Error('页面上下文不完整');
  }
  if (!Number.isInteger(options.tabId) || options.tabId < 0) {
    throw new Error('页面标签页上下文不完整');
  }
  if (!ext.declarativeNetRequest?.updateSessionRules) {
    throw new Error('当前浏览器不支持 declarativeNetRequest');
  }

  const refererUrl = new URL(safeReferer);
  refererUrl.hash = '';

  const ruleId = allocateRuleId(options.kind, options.tabId);
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
          resourceTypes: [DNR_RESOURCE_XMLHTTPREQUEST],
          tabIds: [options.tabId]
        }
      }
    ]
  });
}

export async function installFollowRequestHeaderRule(tabId: number, pageOrigin: string, pageReferer: string): Promise<void> {
  await installRequestHeaderRule({
    kind: 'follow',
    tabId,
    pageOrigin,
    pageReferer,
    regexFilter: '^https://api\\.bilibili\\.com/x/relation/modify(\\?.*)?$'
  });
}

export async function installLikeRequestHeaderRule(tabId: number, pageOrigin: string, pageReferer: string): Promise<void> {
  await installRequestHeaderRule({
    kind: 'like',
    tabId,
    pageOrigin,
    pageReferer,
    regexFilter: '^https://api\\.bilibili\\.com/x/web-interface/archive/like(\\?.*)?$'
  });
}

async function cleanupRulesForTab(tabId: number): Promise<void> {
  const keys = ruleKeysByTabId.get(tabId);
  if (!keys || keys.size === 0 || !ext.declarativeNetRequest?.updateSessionRules) {
    return;
  }

  const ruleIds: number[] = [];
  for (const key of keys) {
    const ruleId = ruleIdByKey.get(key);
    if (ruleId) {
      ruleIds.push(ruleId);
    }
    ruleIdByKey.delete(key);
  }
  ruleKeysByTabId.delete(tabId);

  if (ruleIds.length > 0) {
    await ext.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds
    });
  }
}

if (ext.tabs?.onRemoved) {
  ext.tabs.onRemoved.addListener((tabId) => {
    void cleanupRulesForTab(tabId).catch((error) => {
      console.warn('[BBE] 清理 DNR session rule 失败:', error);
    });
  });
}
