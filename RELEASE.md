# Krill for Magpie v0.20.0

在 Magpie 中使用 Krill 套餐与余额模型，集中查看额度和用量。

- **套餐**：查看本周额度、套餐总额、结转及到期时间。
- **余额**：查看共享钱包、今日余额扣费和官网账号全部调用的请求数、tokens。
- **共用登录**：邮箱密码登录一次，余额入口复用账号并配置独立 Key；支持两步验证和仅 API Key 连接。
- **模型**：读取 Key 可用的模型，余额目录包含图片等类型；支持思考强度、Fast / Ultrafast 和线路参考价格。

## 安装

在 Magpie「插件 → 添加插件」输入：

```text
github:Lovest20018/Magpie-Krill#v0.20.0
```

也可下载下方 `.tgz` 安装包，解压到固定目录，在 Magpie 添加其中的 `package` 目录。

安装后打开「供应商 → 添加供应商」完成连接，获取并选择模型。升级后重载插件；旧模型不可用时重新连接并选择。

Fast / Ultrafast 需要 Magpie v0.1.1281 或更新版本。图片模型可以列出，但 Magpie v0.1.1281 的原生生图入口暂不支持普通供应商插件。实际用量和计费以 Krill 官网为准。

[使用说明](https://github.com/Lovest20018/Magpie-Krill#readme)
