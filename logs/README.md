# 维护日志

这里存放可公开的、脱敏后的长期记录。真实原始请求/响应、密钥、私有代码、完整聊天记录与账单明细不得进入 Git。

| 文件 | 何时更新 |
| --- | --- |
| `decision-log.md` | 策略、模型、阈值或范围改变时 |
| `routing-validation-log.md` | 每次兼容性/回归实验后 |
| `incident-log-template.md` | 发生路由、隐私、质量或成本事件时，复制为独立事件文件 |
| `baseline-cost-template.csv` | 每轮同任务集基线比较后 |
| `change-log-template.md` | 重大实现或运维变更时，复制为独立变更记录 |

建议把一次运行的结构化、脱敏报告保存到未跟踪的 `logs/runs/`；只将汇总与结论提交到仓库。
