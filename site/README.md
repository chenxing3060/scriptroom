# site/ · 剧本工坊加密站点（部署目录）

本目录是可直接部署的加密站点：所有内容页面与图片均为 AES-256-GCM 密文，浏览器输入门禁密码后经 WebCrypto 解密渲染。密文可公开分发，密码不随仓库发布（见根 README「页面加密机制」）。

## 部署方式

### 方式一：GitHub Actions + EdgeOne Pages（默认）

本仓库推送 `main` 即自动部署本目录至 EdgeOne Pages 独立项目 `scriptroom`：

1. EdgeOne Pages 控制台「API Token」页创建 Token；
2. 仓库 **Settings → Secrets and variables → Actions** 添加 `EDGEONE_TOKEN`；
3. Actions 页面重新运行 Deploy 工作流；
4. 自定义域名（如 `scriptroom.allinagi.com.cn`）在 EdgeOne 控制台绑定并按提示添加 CNAME。

### 方式二：任意静态托管 / 自托管

将本目录内容发布到任意 HTTPS 静态服务即可。Nginx 参考配置：

```nginx
server {
    listen 443 ssl http2;
    server_name scriptroom.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    root /var/www/scriptroom;          # 本目录内容
    index index.html;

    # .enc 加密图片以二进制返回，禁止文本编码破坏密文
    location ~* \.enc$ {
        default_type application/octet-stream;
        charset off;
    }

    location /assets/ { expires 7d; add_header Cache-Control "public"; }
    location ~* \.html$ { add_header Cache-Control "no-cache"; }
}
```

> 浏览器解密依赖 WebCrypto，必须 HTTPS（或 localhost）访问。

## 目录内容

| 文件 | 说明 |
|---|---|
| `index.html` | 首页（加密包装：能力总览 + 精选剧本） |
| `scripts.html` | 剧本库（加密包装：6 大母题 × BG/BL/GL 配向双重筛选） |
| `script-new.html` | 撰写新剧本入口（加密包装） |
| `script-<slug>.html` | 剧本详情页（加密包装，十二段结构 + 飞书在线编辑入口） |
| `assets/css/main.css` | 设计系统（玫瑰红/月影紫 女频主题） |
| `assets/js/*.js` | 详情页交互（吸顶/lightbox/双语）与剧本库筛选 |
| `assets/scripts/<slug>/*.jpg.enc` | 加密视觉资产（9:16 Key Art / 16:9 四视图 / 4:3 概念图） |

## 上线验收清单

- [ ] 打开门禁页，错误密码被拒、正确密码解锁首页
- [ ] 剧本库母题 × 配向双重筛选正常，详情页可导航
- [ ] 详情页图片正常解密显示（Network 面板确认 `.enc` 请求 200 且为 `application/octet-stream`）
- [ ] 飞书入口可打开并在线编辑 / 下载 Word/PDF
- [ ] 双语切换（EN/中文）正常
- [ ] 线上密文与本地 SHA-256 一致，下载后可离线解密校验
