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
│   ├── script-<slug>.html         # 剧本详情页（加密包装，十二段结构）
│   ├── assets/css/、assets/js/    # 明文样式与脚本（设计系统：玫瑰红/月影紫）
│   └── assets/scripts/<slug>/*.jpg.enc   # 加密图片资产
├── edge-functions/                # EdgeOne Pages 边缘函数（后端 API）
│   └── api/submissions/
│       ├── index.js               # POST 提交创意 / GET 管理列表
│       └── [id].js                # GET 进度查询 / PATCH 审核状态流转
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
| POST | `/api/submissions` | 公开 | 提交创意。字段：`title`*、`idea`*、`pairing`(bg/bl/gl)*、`category`(六母题)*、`episodes`(60/72/80)*、`benchmark`、`contact`。返回 `{ ok, id, status, statusLabel }` |
| GET | `/api/submissions` | Bearer ADMIN_TOKEN | 管理端查看全部提交（按时间倒序） |
| GET | `/api/submissions/:id` | 公开（编号不可枚举） | 查询单条进度。管理员带 token 返回完整记录 |
| PATCH | `/api/submissions/:id` | Bearer ADMIN_TOKEN | 审核流转：`status` ∈ received / reviewing / generating / published / rejected，可附 `note` |

提交编号形如 `SR_20260828_Ab3xK9mQ`（日期 + 8 位随机字符），用户可在表单提交后直接查询进度。

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
node tools/test-functions.mjs   # 模拟边缘运行时 + 内存 KV，26 项断言
```


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
一句话 logline → Kimi K3 生成十二段文案（圣经/五幕/全集钩子表/英文样章/付费卡点）
               → 速创 API 生成视觉资产（9:16 Key Art / 16:9 角色四视图 / 4:3 概念图）
               → 人工审核（卡点位置 / 合规尺度 / 配向与题材带 / Native 润色）
               → 页面注册入库（scripts.html 卡片 + index.html 精选位）
               → encrypt-all 重加密 → 推送上线
```

每份剧本详情页包含**飞书在线编辑入口**（`feishu-doc-row` 区块），支持在线协作与导出 Word/PDF；内部所有剧本文档统一归档至飞书「剧本工坊」文件夹。

## 与项目预演室（planvis）的隔离边界

| 维度 | planvis 项目预演室 | scriptroom 剧本工坊 |
|---|---|---|
| 密码 | 独立 20 位 | 独立 20 位（互不相通） |
| 内容对象 | 预案（12 段 + 视觉证据） | 剧本包（60-80 集 + 英文样章） |
| localStorage | `planvis-lang` / `pv_unlock` | `scriptroom-lang` / `sr_unlock` |
| 交付物 | 立项决策依据 | 可开机拍摄的剧本包 |

## 当前状态（v1.2 · 2026-08-28）

- 4 个加密页面：首页 / 剧本库（母题 × 配向双重筛选）/ 撰写入口 / 《血月新娘》72 集完整剧本
- 配对取向维度：BG / BL / GL 表单必选 + 筛选直达（`scripts.html?cat=…&pair=…`）
- **在线提交后端**：边缘函数 API（提交 / 进度查询 / 审核流转）+ KV 持久化 + 飞书通知，26 项本地测试通过
- 5 张加密视觉资产（9:16 Key Art / 16:9 角色四视图 / 4:3 场景剧情概念图）
- 页面与图片解密往返均字节级验收通过
