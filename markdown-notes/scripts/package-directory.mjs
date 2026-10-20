import { resolve, dirname, basename } from 'node:path';

// Build beside a running installation instead of removing its locked files.
export function packageDirectory() {
  const output = resolve(process.env.ZHIYE_PACKAGE_DIR || 'release/知页-win-x64');
  if (
    dirname(output) !== resolve('release') ||
    !/^知页(?:-v\d+\.\d+\.\d+)?-win-x64$/.test(basename(output))
  )
    throw new Error('打包输出必须是当前项目release目录中的知页成品目录');
  return output;
}
