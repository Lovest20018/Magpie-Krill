# Krill for Magpie

在 Magpie 原生供应商界面接入 Krill，查看订阅额度并使用账号可用的模型。当前版本 **0.19.1**，供应商 ID 为 `krill-usage`。

这是非官方插件，与 Krill 或 Magpie 运营方没有隶属关系。模型权限、额度和最终计费以 Krill 服务端为准。

## 安装

在 Magpie「插件 → 添加插件」中输入：

```text
github:Lovest20018/Magpie-Krill
```

也可以使用命令行：

```sh
magpie plugin add github:Lovest20018/Magpie-Krill
magpie plugin login krill-usage
```

固定当前版本可使用 `github:Lovest20018/Magpie-Krill#v0.19.1`。使用默认分支安装可继续接收仓库更新；固定标签不会跟随新版本。

安装后，在「供应商 → 添加供应商」选择 Krill，完成连接，再获取模型、勾选所需模型并保存。登录表单位于供应商流程中。

[GitHub Releases](https://github.com/Lovest20018/Magpie-Krill/releases) 同时提供 `.tgz` 安装包和 SHA256 校验文件。将包解压到固定目录，也可在 Magpie 添加其中的 `package` 目录。插件没有第三方运行依赖或安装脚本。

## 功能

| 功能 | 说明 |
| --- | --- |
| 邮箱密码登录 | 使用 Krill 网站邮箱和密码；支持按需进行身份验证器 TOTP 验证 |
| 独立 API Key 连接 | 只连接模型，无需网站登录；Key 不限制 `sk-` 等前缀 |
| 订阅额度 | 显示余额、本周额度、套餐总额、结转额度、积分和请求次数共享池 |
| 原生额度展示 | 普通窗口的金额与百分比同步切换已用/剩余；部分异常保留其他有效数据 |
| 模型目录 | 从所选线路读取当前 Key 实际可用的模型，不从价格表扩充调用权限 |
| 模型能力 | 采用公开元数据的上下文、最大输出和已核实的推理能力；未知值不猜测 |
| 公开参考价格 | Krill 公开标准价乘以所选线路倍率，单位为 USD/百万 token |
| 模型调用 | 支持 Responses、Anthropic Messages 和 OpenAI 兼容 Chat Completions；保留流响应、工具调用和取消信号 |
| 推理和速度参数 | 声明已核实的思考档位与速度能力，并转发宿主实际交给插件的参数 |

## 登录与凭据

连接方式有两种：

- **邮箱密码登录**：模型 Key 选填；留空仅查询额度，填写后还可提供模型。只用 LinuxDo 注册的账号需要先在 Krill 官网设置网站密码，LinuxDo 密码不能代替 Krill 网站密码。
- **API Key 连接（仅模型）**：Key 必填；读取所选线路的模型目录核验连接，不访问网站订阅接口。

网站登录凭据用于额度查询，独立模型 Key 用于模型目录和推理。密码、验证码和本次两步验证会话不长期保存；连接结果由 Magpie 的凭据机制管理。

账号添加、移除和重新登录使用 Magpie 原生流程。**重新登录需要再次填写模型 Key 并选择线路；Key 留空仅查额度，不保留旧 Key。** 网站登录过期时，独立模型 Key 仍可使用。插件不自动续期，不创建、轮换或撤销模型 Key。

## 接入线路

| 线路 | 模型 API 基址 | 公开价格线路键 |
| --- | --- | --- |
| 国内极速（默认） | `https://api-slb.krill-code.net/v1` | `均衡` |
| 海外线路 | `https://api.krill-code.net/v1` | `直连` |
| 三网优化 CDN | `https://api.cdn-krill-ai.com/v1` | `cdn` |

可用性以套餐、Key 权限和网络情况为准。插件不自动切换线路，不自动重试收费推理；多账号顺序、选择和故障处理使用 Magpie 原生设置。

## 额度与配速

额度每次调用都直接读取 Krill 订阅接口；界面的调用频率和缓存由 Magpie 控制，需要最新值时使用宿主刷新操作。

- 周计费套餐优先排列为「本周 → 套餐总额 → 结转额度」，采用服务端报告值，不按套餐天数推算总额。
- 普通额度提供结构化金额和单位。例如上限 600、剩余 295.91 时，已用显示 `304.09 / 600 USD`，剩余显示 `295.91 / 600 USD`，百分比同步变化。
- 单套餐到期时间在卡片摘要显示；多套餐保留逐条北京时间到期说明。重置时间与套餐到期分别处理。
- 部分窗口数据缺失时，在套餐摘要标注「部分额度未知」，保留其他有效额度和余额；全部不可读时明确报错，不将缺失用量画成 0%。
- 多套餐到期、负剩余和超过上限的额外额度保留明确文字，这些金额文字不随模式切换。宿主可将比例限制到 0–100%；窄双栏长文字可悬停查看全文。

配速比较消费比例与周期时间进度。例如周期过去 50%、额度已用 35%，表示比匀速少用 15 个百分点。Magpie 已用模式显示负号，剩余模式符号相反。只有可靠的周期起止时间才提供配速所需信息。

多套餐、结转和余额无法合成可靠的单一账号使用率，因此额度窗口仅用于展示，不承诺某条周限用完就自动切换整个账号。卡片样式、列数和配速标签由 Magpie 绘制。

## 模型、思考强度与速度

Claude 模型使用 Anthropic Messages，GPT/Codex/OpenAI 推理模型使用 Responses，其余使用 OpenAI 兼容 Chat Completions。公开元数据明确为非文本的模型不进入对话列表。

上下文与最大输出采用元数据原值。例如 `1,050,000` 上下文可能在 Magpie 中显示为 1.1M。已识别的当前 Krill GPT 模型可提供 `low`、`medium`、`high`、`xhigh` 推理档位；其他模型按已核实能力提供，不为未知模型虚构档位。

速度与思考强度独立：Standard 使用默认速度，Fast 对应 `service_tier: "priority"`，Ultrafast 对应 `service_tier: "ultrafast"`。插件不默认开启加速档，也不从公开速度价格生成额外可调用模型。

**原生速度入口需要 Magpie 与 Agent 支持。** 当前核对的正式版 Magpie v0.1.1268 尚未读取本插件的 `serviceTiers` 扩展声明，不能保证 Codex 出现 Fast/Ultrafast 按钮。插件可以转发实际收到的参数，但宿主是否保留参数及展示能力取决于其实现。

## 价格与缓存

模型参考价为 **Krill 公开标准价 × 所选线路倍率**，不采用账号渠道或专属优惠覆盖。基础模型价格是默认速度参考价，不能当作 Fast/Ultrafast 切换后的结算价；长上下文、分时条件及账号优惠也可能影响实际费用。

公开价格缺失、无效、禁用、非 token 计费或读取失败时不提供虚假单价，不回用过期价格。Magpie 自己的默认价或用户手设价格不代表 Krill 价格已核实；最终费用在 Krill 官网核对。

目录按账号、Key 和线路在内存缓存 60 秒，最多 50 组；匿名公开元数据缓存 5 分钟。换 Key 或线路使用另一组缓存，重新加载插件清空内存缓存。额度不使用此缓存。

## 可选参数

在 Magpie 插件选项中配置：

```json
{ "timeoutMs": 12000, "maxConcurrency": 4 }
```

`timeoutMs` 为 1000–30000 毫秒，默认 12000；可选公开元数据最多等待 1.5 秒。推理使用 Magpie 的取消控制，不套用 JSON 查询超时。`maxConcurrency` 为 1–1000，仅在显式配置时声明；用户在宿主中的账号或供应商限制优先。

## 开发与验证

需要 Node.js 22+；无需安装第三方依赖：

```sh
npm run check
npm test
npm run release:check
npm run package
```

测试使用合成凭据和模拟请求，不读取真实认证文件，也不发送收费模型请求。GitHub Actions 在 Windows/Linux 和 Node.js 22/24 上执行检查。安装包仅包含运行代码、必要文档、图标与许可证。

数据处理见 [PRIVACY.md](PRIVACY.md)，当前发布说明见 [RELEASE.md](RELEASE.md)。问题请通过 [Issues](https://github.com/Lovest20018/Magpie-Krill/issues) 反馈；不要附带密码、验证码、完整 Key、JWT、Cookie 或含个人信息的原始日志。

## 参考与许可证

- [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)
- [Krill 官网](https://www.krill-code.com)
- [Krill-Usage 参考库](https://github.com/lengmh/Krill-Usage)，许可证为 GPL-3.0-only

本插件独立编写，没有打包参考库的实现源码或原生凭据组件。代码采用 [MIT](LICENSE) 许可证；Krill 官方图标的来源与权利说明见 [NOTICE](NOTICE)。
