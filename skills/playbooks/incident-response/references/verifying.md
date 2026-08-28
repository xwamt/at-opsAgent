# Verifying · 故障排查

独立 Verifier（只读，不复用 Executor）：健康端点 + 关键业务行为 +
监控信号回归基线，三路验证。

禁止：以 exit 0 宣称恢复；跳过业务行为验证。

DoD：三路验证有结论（部分成功如实报部分成功）→ Reporting。
