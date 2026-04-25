# GitHub + Cloudflare Pages 部署说明

推荐把本目录作为一个独立 GitHub 仓库发布，仓库根目录直接包含：

```text
index.html
styles.css
app.js
README.md
DEPLOYMENT.md
```

## GitHub

建议仓库名：

```text
stock-backtester-prototype
```

## Cloudflare Pages

在 Cloudflare 控制台创建 Pages 项目时选择：

- 类型：Pages
- 部署方式：连接到 Git
- Git 提供商：GitHub
- 仓库：`stock-backtester-prototype`
- Framework preset：None / 纯静态站点
- Build command：留空
- Build output directory：`/` 或 `.`

如果 Cloudflare 页面要求必须填写输出目录，优先尝试 `/`；如果界面校验不通过，就填写 `.`。

## 自动更新

Cloudflare Pages 连接 GitHub 仓库后，每次推送到生产分支都会自动部署：

```text
git add .
git commit -m "Update backtester prototype"
git push
```

默认生产分支建议使用 `main`。

## 后续接后端

当前页面是纯静态原型。接入真实行情后，建议：

1. 继续用 Cloudflare Pages 托管前端。
2. 用 FastAPI 或其他服务承载后端接口。
3. 所有行情接口都必须接收 `as_of_date`，并在后端截断未来数据。
4. 前端只展示后端返回的数据，不在浏览器端自行读取完整历史再隐藏。
