# 本地运行结营工作流

Node.js ≥20、当前用户已授权的 lark-cli。无第三方Node依赖，无模型调用。脚本读取真实Base并增量同步，无需飞书内置自动工作流。平台接口、权限与容量限制仍适用。

```text
node runtime/learner/local/run.mjs --config <配置JSON> --preview
node runtime/learner/local/run.mjs --config <配置JSON> --apply
```

省略动作默认preview。配置位置不固定；所有业务文件路径相对配置中 `workspace_root`，而workspace_root相对配置文件目录。CLI通过环境PATH查找 `lark-cli.exe`；其他系统可设置配置中的 `cli` 为实际可执行路径。

配置字段：base_token、source_table、roster_table、course_info、confirmations、identity_registry、course_codes、course_aliases、output_directory、state_directory。可选certificate_ledger用于交叉检查正式账本中的跨期课程编号。人工确认JSON包含confirmed_aliases、confirmed_cross_groups、approvals；approvals每项为course、group、name、basis及明确的优秀标志，不通过名字猜同一身份。

原始打卡及目标表逐页全量读取；任意分页版本变化停止。运行前后对账、源变化和人工并发改动单独报告。每个批次包含source/roster快照、写入计划、课程制证参数、待处理、全流程核对、逐批回执和结果。锁放state_directory；已退出进程遗留的锁保留为abandoned记录后恢复。

读取的瞬时网络错误最多重试两次，写请求不自动重试。失败后新开批次读取现状重算；身份在首次写请求前持久保存，因此创建已成功但回执丢失也不重新分配人员标识。原始打卡和既有人工字段不写；不删除已有名单。

结果中的verified仅表示系统字段回读核验；scope_fully_resolved为false说明还有待确认对象。人工课程保留全部参数，等核准名单后通过制证流程处理，不伪造打卡来源。不创建个人证书、领取附件或定时任务。
