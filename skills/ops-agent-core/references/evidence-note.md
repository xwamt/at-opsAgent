# evidence-note@1

子代理 Investigator 必须返回 JSON（可附在消息末尾的 fenced block）：

```json
{
  "contract": "evidence-note@1",
  "taskId": "t-…",
  "confidence": "confirmed | hypothesis | pending",
  "summary": "≤800 tokens",
  "timeWindow": { "from": "ISO-8601", "to": "ISO-8601" },
  "refs": [
    {
      "kind": "metric | log | config | pipeline | host | other",
      "toolName": "grafana_query_prometheus",
      "pluginId": "at.grafana",
      "preview": "truncated text",
      "artifactUri": "optional"
    }
  ],
  "conflicts": []
}
```

`confirmed` 要求应用侧日志或等价事件证据，不能仅凭指标相关。
