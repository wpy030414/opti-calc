import { defineConfig, lazyPlugins } from 'vite-plus'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// 本地开发与预览恒为根路径；
// CI 注入 PAGES_BASE_PATH 决定线上前缀：项目页 /<repo>/，自定义域或用户页 /
// 代码不做任何域名或仓库名推断
const base = process.env.PAGES_BASE_PATH || '/'

export default defineConfig({
  base,
  // lazyPlugins 让 vp 在只读配置元数据的场景（如 vp fmt / vp lint）跳过插件工厂，
  // 避免为了跑个格式化就把整条 React 插件链加载一遍。
  // 注意参数是回调：lazyPlugins(() => react())，直接传 react 只是碰巧签名兼容。
  plugins: lazyPlugins(() => react()),
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: { host: '0.0.0.0', port: 5173 },
  preview: { host: '0.0.0.0', port: 4173 },
  fmt: { semi: false, singleQuote: true },
  lint: {
    // 必须显式排除，否则 vp lint 会扫描 node_modules
    ignorePatterns: ['node_modules/**', 'dist/**'],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
