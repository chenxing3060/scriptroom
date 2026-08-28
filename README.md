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
│   ├── script-new.html            # 撰写新剧本入口（加密包装）
│   ├── script-<slug>.html         # 剧本详情页（加密包装，十二段结构）
│   ├── assets/css/、assets/js/    # 明文样式与脚本（设计系统：玫瑰红/月影紫）
│   └── assets/scripts/<slug>/*.jpg.enc   # 加密图片资产
├── tools/
│   ├── crypto.mjs                 # 加解密核心（密码经环境变量/本地文件注入）
│   ├── cli.mjs                    # 加密 / 解密 / 批量工具
│   └── template.html              # 加密外壳（门禁 UI + WebCrypto 解密逻辑）
└── .github/workflows/deploy.yml   # 推送 main 自动部署至 EdgeOne Pages
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

推送到 `main` 分支即触发 GitHub Actions 自动部署 `site/` 至 EdgeOne Pages（独立项目 `scriptroom`，与主站互不影响）。

首次使用需配置一次密钥：

1. 在 [EdgeOne Pages 控制台](https://edgeone.cloud.tencent.com/pages) 的「API Token」页创建 Token；
2. 在本仓库 **Settings → Secrets and variables → Actions** 添加名为 `EDGEONE_TOKEN` 的密钥；
3. 在 **Actions** 页面重新运行 Deploy 工作流。

未配置密钥时工作流会以警告跳过部署（不会报红）。自定义域名（如 `scriptroom.example.com`）在 EdgeOne 控制台的项目设置中绑定，并按提示添加 CNAME 解析。

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

## 当前状态（v1.1 · 2026-08-28）

- 4 个加密页面：首页 / 剧本库（母题 × 配向双重筛选）/ 撰写入口 / 《血月新娘》72 集完整剧本
- 配对取向维度：BG / BL / GL 表单必选 + 筛选直达（`scripts.html?cat=…&pair=…`）
- 5 张加密视觉资产（9:16 Key Art / 16:9 角色四视图 / 4:3 场景剧情概念图）
- 页面与图片解密往返均字节级验收通过
