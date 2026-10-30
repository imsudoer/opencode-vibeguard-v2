/**
 * 本地目录形式安装时的入口（V2 解析 `<dir>/server`）。
 * 统一转发到 src/index.js，保证与 npm 安装的导出面一致。
 */
export { default } from "./src/index.js"
export * from "./src/index.js"
