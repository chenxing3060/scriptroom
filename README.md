# 天星AI · 剧本工坊（ScriptRoom）

北美本土剧女频竖屏剧的独立剧本撰写系统：从一句话 logline 到「60-80 集可开机拍摄的完整剧本包」——剧本圣经、五幕主线、全集分集钩子表、英文对白样章、付费卡点设计与 AI 视觉资产。支持 **BG 男女 / BL 男男 / GL 女女** 三种配对取向 × 6 大母题交叉组合。

**在线演示**：https://allinagi.com.cn/scriptroom/ （内容全部以密文部署，浏览器端输入密码解锁）

## 这个仓库里有什么

本仓库公开的是**系统与密文产物**——加密站点、加解密工具链与部署配置。剧本明文源文件与门禁密码不入库（内容资产保护），线上密码门禁因此始终有效。

```
scriptroom/
├── site/                          # 可直接部署的加密站点（本仓库部署此目录）
│   ├── index.html                 # 首页（AES-256-GCM 加密包装）
│   ├── scripts.html               # 剧本库（6 大母题 × BG/BL/GL 配向双重筛选）
│   ├── script-new.html            # 撰写新剧本入口（真实在线提交，加密包装）
│   ├── pipeline.html              # 管线编辑工作台（AI 生成 → 在线编辑 → 确认推进）
│   ├── script-<slug>.html         # 剧本详情页（加密包装，十二段结构）
│   ├── assets/css/、assets/js/    # 明文样式与脚本（设计系统：玫瑰红/月影紫）
│   └── assets/scripts/<slug>/*.jpg.enc   # 加密图片资产
├── edge-functions/                # EdgeOne Pages 边缘函数（后端 API）
│   └── api/submissions/
│       ├── index.js               # POST 提交创意 / GET 管理列表（含阶段摘要）
│       └── [id].js                # GET 进度/拉图 / PATCH 管线 action 分发
└── tools/
    ├── crypto.mjs                 # 加解密核心（密码经环境变量/本地文件注入）
    ├── cli.mjs                    # 加密 / 解密 / 批量工具
    ├── template.html              # 加密外壳（门禁 UI + WebCrypto 解密逻辑）
    └── test-functions.mjs         # 边缘函数本地测试（模拟运行时 + 内存 KV）
```

## 页面加密机制

所有内容页面与图片均为 AES-256-GCM 加密，密钥为 20 位访问密码的 SHA-256：

```
明文 HTML ──encrypt-all──▶ 外壳页（base64 PAYLOAD + KEY_HEX）──部署──▶ CDN
浏览器：输入密码 → SHA-256 派生密钥 → WebCrypto 解密 → 渲染 DOM
图片：*.jpg.enc 按需 fetch → 解密为 Blob → <img> 展示
```

- 密码本身不出现在任何仓库文件中（`KEY_HEX` 是单向哈希，无法反推密码）
- 浏览器解密依赖 WebCrypto，需 HTTPS（或 localhost）访问
- 密码错误时页面拒绝渲染，密文本身可公开分发

## 在线提交后端（Edge Functions）

「撰写新剧本」表单为真实在线提交：数据持久化到 EdgeOne Pages **KV 存储**，并可推送**飞书群机器人通知**。API 由 `edge-functions/` 目录下的边缘函数提供（与静态站点同域，无 CORS 问题）。

### API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/submissions` | 公开 | 提交创意。字段：`title`*、`idea`*、`pairing`(bg/bl/gl)*、`category`(六母题)*、`episodes`(60/72/80)*、`benchmark`、`contact`。返回 `{ ok, id, editKey, status, statusLabel }`——`editKey` 为 16 位提交者编辑密钥，**仅此一次返回**（服务端只存 SHA-256 哈希） |
| GET | `/api/submissions` | Bearer ADMIN_TOKEN | 管理端查看全部提交（按时间倒序，含各阶段状态摘要，不含阶段正文）。编辑密钥不可访问列表 |
| GET | `/api/submissions/:id` | 公开（编号不可枚举） | 查询单条进度（含 `stage` / `stageLabel` / `stageStatusLabel`）。管理员带 token 或提交者带 `X-Edit-Key` / `?key=` 返回完整记录（`role` 区分身份）；凭据错误返回 401，无凭据返回公开摘要 |
| GET | `/api/submissions/:id?img=<key>` | 管理员或提交者 | 拉取审阅图片，以 `image/jpeg` 二进制返回 |
| PATCH | `/api/submissions/:id` | 管理员或提交者 | 管线 action 分发（见下表）；无 `action` 字段时兼容旧版 `{status, note}` 流转 |

提交编号形如 `SR_20260828_Ab3xK9mQ`（日期 + 8 位随机字符），用户可在表单提交后直接查询进度。

**权限矩阵**：管理员（Bearer ADMIN_TOKEN）可操作全部记录的全部 action；提交者（X-Edit-Key）仅能操作自己这一条记录，且拥有与管理员相同的编辑确认权限（stage-content / request-generate / decision / edit-ep / assets-choice），但不可访问列表接口。旧记录（无 `editKeyHash`）密钥鉴权一律 401，仅管理员可管理。

### PATCH action 一览

| action | 请求体 | 行为 |
|---|---|---|
| `stage-content` | `{action, stage, content, ready?}` | 写入阶段内容（outline / synopsis / script / assets）。`ready`（默认 true）置「待确认」并推进 `stage`、飞书通知；`ready:false` 供剧本**分批写入**（按 ep 合并、更新 progress）。agent 或用户调用 |
| `request-generate` | `{action, stage}` | **请求 AI 撰写**：把当前阶段从 `empty`（或幂等的 `requested`）置为 `requested`，飞书通知管理员安排生成。仅对当前阶段、且状态为 empty/requested 时可用。用户调用 |
| `decision` | `{action, stage, decision:"approved"\|"rejected", note}` | 「确认推进」：`approved` 锁定该阶段并自动进入下一阶段（工作台确认按钮触发；如有未保存编辑会先自动保存）。`rejected` 仅保留作 API 兼容，新界面不再使用 |
| `edit-ep` | `{action, ep, data:{title,hook,scenes}}` | **模块化单集编辑**：按集号 upsert（场景/对白行可增删）。仅剧本阶段「待确认/已驳回」时可用。用户调用 |
| `assets-choice` | `{action, choice:"generate"\|"skip"}` | 选择生成视觉资产或**跳过生图**（跳过仍可上线，详情页无图、封面用主题色渐变）。用户调用 |
| `asset-put` | `{action, key, label, aspect, mime, dataBase64}` | 上传单张审阅图片（解码后 ≤400KB），存独立 KV key `sub_<id>_img_<key>`，主记录只存元数据。agent 调用 |
| `publish-done` | `{action, feishuDocUrl, pageUrl}` | 发布完成：`stage=done`、`status=published`、飞书上线通知。agent 调用 |

### 控制台一次性配置（部署后）

1. **KV 存储**：控制台左侧「KV 存储」→ 申请开通账户 → 创建命名空间（如 `scriptroom_subs`）→ 进入项目 `scriptroom` → 设置 → KV 存储 → 绑定命名空间，**变量名必须为 `SUBMISSIONS_KV`**；
2. **环境变量**（项目设置 → 环境变量）：
   - `ADMIN_TOKEN`（必填，管理端鉴权）：建议 `openssl rand -hex 16` 生成；
   - `FEISHU_WEBHOOK`（可选）：飞书群自定义机器人的 Webhook 地址，新提交实时推送卡片；
   - `FEISHU_WEBHOOK_SECRET`（可选）：机器人开启签名校验时的密钥，函数自动计算签名；
3. 修改配置后**重新部署一次**使环境变量生效。

未完成上述配置时：提交接口返回 503 并提示原因（KV 未绑定 / 未配置 ADMIN_TOKEN），不影响静态站点访问。

### 本地测试

```bash
node tools/test-functions.mjs   # 模拟边缘运行时 + 内存 KV，89 项断言（含 v1.5 编辑密钥链与请求生成）
```

## 多阶段编辑确认管线（v1.5 · 提交即入编辑）

提交成功即进入编辑管线：提交者在成功页拿到**提交编号 + 16 位编辑密钥**（并自动跳转，密钥存本机 localStorage），可直接进入加密编辑工作台 `pipeline.html` 逐阶段「请求 AI 撰写 → 在线编辑 → 确认推进」，直至剧本完成上线。管理员凭 `ADMIN_TOKEN` 管理全部提交，权限与提交者等同（另可看列表）。

```
提交创意 ─▶ ① 大纲 ─▶ ② 分集梗概 ─▶ ③ 完整剧本(全集·逐集编辑) ─▶ ④ 视觉资产 ─▶ ⑤ 发布上线 ─▶ done
           请求生成→编辑→确认  请求生成→编辑→确认  请求生成→逐集编辑→确认    生成或跳过→确认   飞书文档+线上
```

### 阶段状态机

- 通用：`empty → requested(已请求生成) → pending_review(待编辑确认) → approved(已确认)`
- `empty` 状态也可**跳过请求直接手动填写**：表单保存（ready:true）即进入 `pending_review`
- 剧本阶段支持 `draft`（agent 分批写入中，60-80 集按 6-12 集/批规避 1MB 请求体限制）
- 资产阶段特有：`awaiting_choice → generating → pending_review → approved` 或 `→ skipped`
- 已确认的阶段**内容锁定**；`rejected` 仅作旧记录 / API 兼容保留，编辑界面不再产生驳回

### KV 记录结构（节选）

```jsonc
{
  "id": "SR_20260828_Ab3xK9mQ", "status": "generating",
  "editKeyHash": "sha256(16位编辑密钥)",        // 明文密钥仅在 POST 响应出现一次
  "stage": "outline",                       // outline|synopsis|script|assets|publish|done
  "stages": {
    "outline":  { "status": "pending_review", "feedback": "", "content": { "logline": "…", "fiveActs": [ … ] } },
    "synopsis": { "status": "empty", "content": { "episodes": [ { "ep": 1, "title": "…", "hook": "…" } ] } },
    "script":   { "status": "empty", "progress": { "total": 72, "written": 0 },
                  "content": { "episodes": [ { "ep": 1, "scenes": [ { "slug": "INT. X - NIGHT", "lines": [ … ] } ] } ] } },
    "assets":   { "status": "empty", "content": { "items": [ { "key": "cover", "aspect": "9:16" } ] } },
    "publish":  { "status": "empty", "content": { "feishuDocUrl": "", "pageUrl": "" } }
  }
}
```

旧记录（无 `stage`/`stages`）自动按 `outline · 未开始` 兼容处理；旧记录无 `editKeyHash`，编辑密钥鉴权一律 401。

### Agent 编排示例（curl）

```bash
ID=SR_20260828_Ab3xK9mQ; T=$ADMIN_TOKEN; API=https://scriptroom.example.com/api/submissions

# 写入大纲并送审
curl -X PATCH $API/$ID -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"action":"stage-content","stage":"outline","content":{ … }}'

# 剧本分批写入（第 1 批），最后一批 ready:true 送审
curl -X PATCH $API/$ID -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"action":"stage-content","stage":"script","ready":false,"content":{"episodes":[ …12集… ]}}'

# 上传审阅图片（≤400KB，base64）
curl -X PATCH $API/$ID -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"action":"asset-put","key":"cover","label":"Key Art 封面","aspect":"9:16","mime":"image/jpeg","dataBase64":"…"}'

# 发布完成（飞书文档 + 线上页面就绪后）
curl -X PATCH $API/$ID -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"action":"publish-done","feishuDocUrl":"https://…","pageUrl":"https://…"}'
```

### 编辑工作台（pipeline.html）

门禁为**双模式**：「管理员」输入 `ADMIN_TOKEN`（存本机 localStorage）；「我是提交者」输入**提交编号 + 编辑密钥**（成功页深链 `pipeline.html?id=<编号>&key=<密钥>` 自动登录，密钥存 `localStorage['sr_edit_key_<id>']`，URL 中的密钥登录后即剥离）。两种身份在详情页权限等同；提交者无列表视图，退出编辑即返回入口。

管理员列表视图：全部提交 + 当前阶段徽章，点击进入编辑。各阶段面板：

1. **大纲**：`empty` 状态显示「✦ 请求 AI 撰写大纲」按钮（点击置为已请求生成，等待 agent 写入；也可直接在空表单手动填写）；内容就绪后全部字段可编辑（logline 双语 / 题材标签 / 世界观 / CP 动力学 / 人物表增删 / 五幕卡增删）→「保存修改」暂存或「确认无误，进入下一阶段」（自动保存后推进）；
2. **分集梗概**：同样支持请求生成 / 手动「+ 添加一集」；内容就绪后全集表格逐格编辑（标题 / 钩子 / 节拍 / 付费标记）→ 保存 / 确认推进；
3. **完整剧本**：`empty` 状态可请求生成；分批写入期间显示进度；就绪后左侧集数网格（已编辑徽章）、右侧**单集模块化编辑器**（标题 / 钩子 / 场景 / 对白行[角色·英文·中文]，可增删），「保存本集」即时落库，全部满意后确认推进；
4. **视觉资产**：选择「生成」或「跳过」；生成后画廊逐张查看（图片按需 fetch 渲染）→ 确认推进；
5. **发布**：显示飞书文档与线上页面链接，全链路闭环。

「撰写新剧本」页提交成功后：成功页展示编号与编辑密钥（仅显示一次，带复制按钮）、「进入编辑工作台」大按钮，以及 8 秒倒计时自动跳转（可点「暂不跳转」取消）。

确认动作会自动保存未保存的编辑（大纲 / 梗概），并在飞书推送「阶段已确认」通知。

### 飞书通知事件

| 事件 | 触发时机 |
|---|---|
| 新提交 | POST /api/submissions |
| 请求生成 | request-generate（提交者请求 AI 撰写某阶段） |
| 已生成可编辑确认 | stage-content `ready:true` |
| 阶段已确认 | decision approved |
| 资产生成选择 | assets-choice |
| 上线通知 | publish-done（带飞书文档与页面链接） |


## 快速开始

```bash
git clone https://github.com/chenxing3060/scriptroom.git
cd scriptroom

# 1) 生成自己的 20 位门禁密码（二选一注入）
openssl rand -base64 15 > tools/.password          # 方式 A：本地密码文件（已 gitignore）
export SCRIPTROOM_PASSWORD=$(openssl rand -base64 15)  # 方式 B：环境变量

# 2) 把你的明文页面放进 source/（目录已 gitignore，不会提交）
#    source/index.html、source/assets/css|js、source/assets/scripts/<slug>/*.jpg

# 3) 全量加密 source/ → site/（页面加密 + 图片加密 + css/js 同步）
node tools/cli.mjs encrypt-all

# 4) 本地预览加密站点（localhost 下 WebCrypto 可用）
cd site && python3 -m http.server 8080

# 5) 校验解密往返
node tools/cli.mjs decrypt site/index.html | head
node tools/cli.mjs decrypt-img site/assets/scripts/<slug>/x.jpg.enc > /tmp/x.jpg
```

**更换密码**：更新 `tools/.password`（或环境变量）→ `encrypt-all` 全量重加密 → 部署。

## 部署

`site/` 是纯静态加密站点，可部署到任何 HTTPS 静态托管。以 EdgeOne Pages 为例（独立项目 `scriptroom`，与主站互不影响），两种方式二选一：

### 方式一：EdgeOne 控制台 Git 集成（推荐，零 CI 依赖）

1. [EdgeOne Pages 控制台](https://edgeone.cloud.tencent.com/pages) → 创建项目 → 导入 Git 仓库 → 选择本仓库；
2. 构建配置中输出目录设为 `site/`；
3. 之后每次推送 `main` 自动部署，不依赖 GitHub Actions。

### 方式二：GitHub Actions

1. 在仓库网页界面创建文件 `.github/workflows/deploy.yml`，粘贴以下内容：

```yaml
name: Deploy to EdgeOne Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install EdgeOne CLI
        run: npm install -g edgeone@latest

      - name: Deploy site/ to EdgeOne Pages (project: scriptroom)
        env:
          EDGEONE_TOKEN: ${{ secrets.EDGEONE_TOKEN }}
        run: |
          if [ -z "$EDGEONE_TOKEN" ]; then
            echo "::warning::未配置 EDGEONE_TOKEN 密钥，跳过部署。请在 Settings → Secrets and variables → Actions 添加后重新运行本工作流。"
            exit 0
          fi
          edgeone pages deploy site -n scriptroom -t "$EDGEONE_TOKEN" \
            || edgeone makers deploy site -n scriptroom -t "$EDGEONE_TOKEN"
```

2. 在 EdgeOne 控制台「API Token」页创建 Token，添加到仓库 **Settings → Secrets and variables → Actions**（名称 `EDGEONE_TOKEN`）；
3. 推送 `main` 或手动触发工作流即自动部署。

自定义域名（如 `scriptroom.example.com`）在 EdgeOne 控制台的项目设置中绑定，并按提示添加 CNAME 解析。

## 新增剧本流程

```
一句话 logline → 五阶段编辑确认管线（大纲 → 分集梗概 → 完整剧本·逐集编辑 → 视觉资产·可跳过 → 发布）
               → Kimi K3 生成文案 / 速创 API 生成视觉资产（9:16 Key Art / 16:9 角色四视图 / 4:3 概念图）
               → 每阶段在 pipeline.html 在线编辑修改 → 确认后自动进入下一阶段
               → 飞书文档（归档至「剧本工坊」文件夹）+ 页面注册入库（scripts.html 卡片 + index.html 精选位）
               → encrypt-all 重加密 → 推送上线 → PATCH publish-done 闭环
```

每份剧本详情页包含**飞书在线编辑入口**（`feishu-doc-row` 区块），支持在线协作与导出 Word/PDF；内部所有剧本文档统一归档至飞书「剧本工坊」文件夹。

## 与项目预演室（planvis）的隔离边界

| 维度 | planvis 项目预演室 | scriptroom 剧本工坊 |
|---|---|---|
| 密码 | 独立 20 位 | 独立 20 位（互不相通） |
| 内容对象 | 预案（12 段 + 视觉证据） | 剧本包（60-80 集 + 英文样章） |
| localStorage | `planvis-lang` / `pv_unlock` | `scriptroom-lang` / `sr_unlock` |
| 交付物 | 立项决策依据 | 可开机拍摄的剧本包 |

## 当前状态（v1.5 · 2026-08-28）

- 5 个加密页面：首页 / 剧本库（母题 × 配向双重筛选）/ 撰写入口 / 管线编辑工作台 / 《血月新娘》72 集完整剧本
- 配对取向维度：BG / BL / GL 表单必选 + 筛选直达（`scripts.html?cat=…&pair=…`）
- **在线提交后端**：边缘函数 API（提交 / 进度查询 / 管线 action 分发 / 图片端点）+ KV 持久化 + 飞书通知，89 项本地测试通过
- **五阶段编辑确认管线**：AI 生成 → 在线编辑（大纲全字段 / 梗概逐格 / 剧本逐集模块化）→ 确认后自动进入下一阶段 → 视觉资产（可跳过生图）→ 发布上线（飞书文档 + 线上剧本库）
- **提交即入编辑管线（v1.5）**：提交成功返回 16 位编辑密钥（服务端仅存哈希），成功页展示密钥 + 深链按钮 + 8 秒倒计时自动跳转；工作台门禁双模式（管理员令牌 / 提交者编号+密钥），各内容阶段提供「请求 AI 撰写」默认按钮（empty → requested），空状态亦可直接手动填写保存推进
- 5 张加密视觉资产（9:16 Key Art / 16:9 角色四视图 / 4:3 场景剧情概念图）
- 页面与图片解密往返均字节级验收通过
