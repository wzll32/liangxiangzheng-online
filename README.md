# 两相争 · 联机版（房间号）

三国题材的五条战线卡牌对战：真人 vs AI，或两个人用房间号联机对战。
纯静态前端 + 零依赖 Node 服务端（只用内置模块，不需要 npm install、不需要数据库）。

## 本地局域网玩

1. 装 Node 18+，在这个目录执行 `node server.js`
2. 浏览器打开 http://localhost:8080
3. 两台设备打开同一个地址，一方「创建房间」拿到 4 位房间号，另一方输房间号加入

## 部署到公网（Render）

1. 用 GitHub 登录 https://render.com
2. New → Blueprint → 选这个仓库（`render.yaml` 已经写好配置）
   或者 New → Web Service，Start Command 填 `node server.js`，Plan 选 Free
3. 部署完拿到 `https://xxxx.onrender.com`，两个人打开同一个网址、填同一个房间号即可

免费实例 15 分钟无人访问会休眠，下次首次打开需要 30–60 秒唤醒，之后正常。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 游戏本体（单文件，含 AI、同屏双人、联机客户端） |
| `server.js` | 联机服务端：房间管理 + SSE 广播 + 静态文件 |
| `package.json` | `npm start` → `node server.js` |
| `render.yaml` | Render 一键配置 |

## 已知限制

- 房主断线即散局（没有断线重连）
- 客人端不播结算动画，直接看到结果
- 房主固定先手
- 只支持两人一局

游戏规则与数值设计：堇闲（王谨承、张淑娴、曾友德）
