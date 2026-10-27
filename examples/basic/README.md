# cesium-geospatial · basic example

最小接入示例：一个 Cesium `Viewer` + 一行 `installAtmosphereClouds(viewer, { quality: 'high' })`。

依赖声明为 `"cesium-geospatial": "file:../.."`（不是 `workspace:*`）：安装时 pnpm 会把仓库根包
按 `files` 字段**拷贝**成独立包（只含 `dist`/`assets`/`bin`/`docs`/`README.md`，不含 `src`/`.git`），
与真实消费方（git submodule + `file:`）走同一条路径。

## 运行（三步）

1. **构建根包**（本示例消费 `dist/`；成功后根目录应出现 `dist/build-stamp.json`）：

   ```bash
   cd ../..
   pnpm run build
   ```

2. **安装示例依赖**（示例不在 `pnpm-workspace.yaml` 内，必须加 `--ignore-workspace`，
   否则会被外层 workspace 作用域接管、示例自己不会生成 `node_modules`）：

   ```bash
   cd examples/basic
   pnpm install --ignore-workspace
   ```

3. **启动**：

   ```bash
   pnpm dev
   ```

   打开 <http://localhost:5173>。`predev` 会先跑根包 CLI
   （`node ../../bin/cli.mjs copy-assets --out public/cesium-geospatial-assets`），
   把 10 个运行期资产（luts 4 + clouds 4 + moon 2）拷进 `public/`。

生产构建：`pnpm build`（`prebuild` 同样先拷资产）→ `pnpm preview`。

## 页面里有什么

- 默认 `baseLayer: false`（示例不带 ion token），裸 globe + 大气 + 体积云；控制台无请求失败。
- **首屏即云海**：示例把相机放在 `-80.6057,64.5197,15000`（15km，卷云顶 8km 之上）、
  heading 68.8° / pitch -30° 俯视云层，并把时钟钉在 `2026-08-28T17:30:00Z` 保证任何时刻
  打开都是白天。15km 既在云层之上（不会落进云里变一片灰雾），又远低于「300km 以上云渐隐」。
  删掉 `src/main.ts` 里这几行，即回到实时太阳 + Viewer 默认全球视角。
- **体积云在 300km 以上按设计渐隐**：从首屏机位拉远到 300km 以上，云会淡出、只剩大气。
- 想加底图：给 `Viewer` 传 `baseLayer`，或先设 `Ion.defaultAccessToken`。
- 需要换资产位置时用 `installAtmosphereClouds(viewer, { assetsBaseUrl: 'https://cdn.example.com/geo-assets/' })`，
  目录内需保持 `luts/`、`clouds/`、`moon/` 三子目录结构。

## 版本钉法（重要）

`cesium` 钉在 **1.143.0**、并用 `pnpm.overrides` 把 `@cesium/engine` 钉在 26.1.0
（`@cesium/widgets` 16.1.0）——这是本库当前已验证的 Cesium 版本表（`src/compat.ts`）。

- 实测 `cesium@1.146.0`：云 stage 的 MRT shader 与 Cesium 自动注入的 `out_FragData_*`
  输出位置冲突，渲染直接中止（`An error occurred while rendering`）。
- 实测 `cesium@1.143.0` + `@cesium/engine@26.4.0`（`^26.1.0` 默认解析结果）：
  该 engine 版本已不导出 `cesium/Source/Cesium.js` 需要的符号，Vite dev 启动即报
  `No matching export ... for import "AttributeCompression"`。

升级 Cesium 时先确认本库的版本表已更新，再同步调整这里的版本与 override。

## 构建产物提示

`vite-plugin-static-copy` 把 Cesium 的 `Workers/Assets/ThirdParty/Widgets` 拷到 `dist/cesium/`，
`public/cesium-geospatial-assets/` 拷到 `dist/cesium-geospatial-assets/`——部署时整个 `dist/`
原样上线即可，不需要额外配置静态路由。
