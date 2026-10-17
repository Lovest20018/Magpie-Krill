# Krill for Magpie

在 Magpie 中使用 Krill 模型，查看套餐额度、钱包余额和今日用量。

## 功能

| 供应商 | 用途 |
| --- | --- |
| **Krill · 套餐** | 使用套餐模型，查看本周额度、套餐总额、结转和到期时间 |
| **Krill · 余额** | 使用余额 Key 下的模型，查看共享钱包、今日余额扣费和账号用量 |

支持多账号、思考强度、Fast / Ultrafast 和 Krill 线路参考价格。可用模型与功能以你的 Key 权限为准。

## 安装

在 Magpie「插件 → 添加插件」中输入：

```text
github:Lovest20018/Magpie-Krill
```

也可在 [Releases](https://github.com/Lovest20018/Magpie-Krill/releases/latest) 下载安装包，解压到固定目录后，在 Magpie 添加其中的 `package` 目录。

1. 打开「供应商 → 添加供应商」，选择「Krill · 套餐」或「Krill · 余额」。
2. 按下面的方式连接账号。
3. 获取模型、勾选所需模型并保存。

升级后重载插件或重启 Magpie；若旧模型不可用，重新连接供应商并获取模型。

## 连接账号

- **查看额度和余额**：两个入口都可使用 Krill 邮箱密码登录，支持两步验证。登录一次后，另一边选择已登录账号，配置自己的 Key 和线路即可；也可选择「登录其他账号」。套餐 Key 可留空，仅查看额度；余额 Key 必填。
- **仅使用模型**：选择「API Key 连接」，填写 Key 和线路。Key 不限制前缀；此方式不显示官网余额和统计。

仅通过 LinuxDo 注册的账号，请先在 Krill 官网设置网站密码。已有登录未出现时，先刷新供应商列表。

官网登录过期后重新登录即可，独立模型 Key 仍可使用。重新登录时需重填当前连接的 Key 和线路；其他关联连接会同步官网状态，保留各自的 Key。

## 使用说明

- 钱包和今日统计属于整个 Krill 账号，包含其他 Key 和客户端；多个连接显示的同一钱包不能相加。今日按北京时间计算，统计最多缓存 1 分钟。
- 在 Magpie 的模型选择器中调整思考强度和速度。Fast / Ultrafast 需要 Magpie v0.1.1281 或更新版本，并且模型支持对应档位。
- 余额入口会列出 Key 下的图片等模型。图片生成由 Magpie 提供；Magpie v0.1.1281 的原生生图入口暂不支持普通供应商插件。
- 显示的价格为线路参考价，加速档、账号优惠等可能影响实际费用，以 Krill 官网账单为准。

[问题反馈](https://github.com/Lovest20018/Magpie-Krill/issues) · [隐私说明](PRIVACY.md) · [Krill 官网](https://www.krill-code.com)

非官方项目，与 Krill 或 Magpie 运营方无隶属关系。代码采用 [MIT](LICENSE) 许可证，图标说明见 [NOTICE](NOTICE)。
