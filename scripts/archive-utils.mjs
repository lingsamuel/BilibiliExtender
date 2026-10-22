import { spawn } from 'node:child_process';

/** 共享系统 zip 调用；参数数组避免文件路径经过 shell 解释。 */
export function runZip(args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('zip', args, {
      cwd,
      stdio: 'inherit'
    });

    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`zip 执行失败，退出码: ${code ?? '(null)'}`));
    });
  });
}

