# UX-02C-02-R2 证据说明（结构变更的资源意图）

父提交 `92a2565922a31c14037f659627a24ff839af7baa`（UX-02C-05-R1.2）。
本目录**只增不改**：上一轮的 `docs/evidence/ux-02c-05-r12-identity-ownership/`
保持原样。

环境：Windows + Node（`--experimental-strip-types`）。
运行测试前必须显式设定临时目录：

```bash
export TMP=C:/Users/Administrator/AppData/Local/Temp \
       TEMP=C:/Users/Administrator/AppData/Local/Temp \
       TMPDIR=C:/Users/Administrator/AppData/Local/Temp
```

`os.tmpdir()` 在该机器上会解析成 8.3 短路径（`C:/Users/ADMINI~1/...`），
导致项目根比对失败并让上百条用例误报 `ERR_PROJECT_UNAVAILABLE`。
这与本轮改动无关，是环境问题。

---

## 一、文件清单

| 文件 | 内容 |
|---|---|
| `red-suite-110.txt` | 套件 110 首次运行（先红）：33 例 → 25 pass / 8 fail |
| `mutations.json` | 11 个变异探针的结果（全部 BITTEN + 逐字节还原） |
| `mutate.mjs` | 变异脚本（证据工具，不参与产品代码） |
| `verify-r2.mjs` | 真实浏览器验收脚本（真实 Host + 真实 Vite + 真实 Chrome） |
| `browser-verification.json` | 52 项检查的逐项结果与事实快照 |
| `01-rename-rejected.png` | 改名被拒：输入行保留 + 状态栏说明原因 |
| `02-rename-after-refresh-applied.png` | 刷新后对当前对象改名成功 |
| `03-move-rejected.png` | 移动被拒：对话框保留 + 行内原因 |
| `04-move-after-refresh-applied.png` | 刷新后对当前对象移动成功 |
| `gate-test-p0.txt` | 全量 `npm run test:p0` |
| `gate-typecheck-build.txt` | `typecheck` / `typecheck:apps` / `build:shell` / `git diff --check` |

---

## 二、先红（`red-suite-110.txt`）

第一次运行套件 110 时 8 条失败，全部是**产品缺口**，没有一条是断言写错：

| 失败用例 | 暴露的缺口 |
|---|---|
| `I-03` 锚属于另一个文件 | Host 没有比对锚，只读身份不比对 |
| `I-04` 外部删除重建同名文件 | 同上；请求照发，新对象被搬走 |
| `I-05` 源已删除 | 缺 404 的独立判定 |
| `I-06` Provider 无身份能力 | Host 没有拦截，退化成注定失败的路径操作 |
| `I-07` 占位后源被替换 | Provider 没有第二处核验 |
| `I-08` 占位后源被删除 | 同上；占位残留 0 字节文件 |
| `I-09` 大小写仅变化 | 锚不符时照样放行 |
| `R-04` 客户端自述不被采信 | `absolutePath` / `rootToken` / `providerId` 被静默忽略 |

补完实现后 43/43 全绿。

### 后加的用例如何证明有判别力

`M-01`（隐藏记录）、`M-02`（元数据不继承）、`I-10`（绕开 Host 直调 Provider）
以及套件 73 的「拒绝上报」用例是在实现之后补的，没有独立的先红日志。
它们的判别力由变异探针证明（见下）：M11 → M-01、M04 → M-02、M06 → I-10、
M10 → 套件 73 的拒绝上报用例。其中 M10 还单独做过一次手工红绿（摘掉上报 → 只有
该用例变红 → 逐字节还原）。

---

## 三、变异探针（11/11 BITTEN）

每个探针只改一处，且都 `restoreExact: true`（SHA-256 逐字节还原）。

| ID | 改坏什么 | 咬住的用例 |
|---|---|---|
| M01 | Shell 发请求时把预期锚换成空串 | S-13 |
| M02 | Shell 不拦"没有锚"，照发请求 | S-11 |
| M03 | Host 跳过锚形状校验 | I-01、I-02 |
| M04 | Host 只读身份、不比对 | M-02、I-03、I-04、I-09、R-04 |
| M05 | Host 跳过 Provider 身份能力检查 | I-06 |
| M06 | Provider 忽略预期源身份（第一处比对） | I-10 |
| M07 | Provider 删掉 `rename` 前的最终复核 | I-07、I-08 |
| M08 | Host 跳过会话保护 | R-01 |
| M09 | Shell 在 UNKNOWN 之后自动重发 | 套件 73 UNKNOWN 用例 |
| M10 | Shell 不把"源对象已变"的拒绝上报给层表 | 套件 73 拒绝上报用例 |
| M11 | 记录核验绕过：路径上没对象也当作仍成立 | M-01 |

`M04` 一次咬住 5 条用例，说明"Host 比对锚"这一处判定被多条正交断言覆盖
（外部替换、锚属他人、仅大小写变化、客户端自述、元数据不继承）。

---

## 四、真实浏览器（52/52）

脚本 `verify-r2.mjs`，只碰 `D:/Workspace/projects/weavespace-test/c02-r2`。

### 4.1 改名（A 段，25 项）

1. 真实 Chrome 右键 → 「重命名」→ 行内输入框打开并预填 `a.md`（A-03~A-05）；
2. **界面不刷新**的情况下，在磁盘上删除并重建同名文件（A-06~A-08：
   Host 的锚变了、行上仍是旧锚、inode 不同）；
3. 按 Enter 提交 → 请求体里的 `sourceAnchor` **是旧锚**（A-09），
   且不带任何客户端自述路径/令牌/身份（A-10）；
4. Host 明确拒绝：`409` + `ERR_ENTRY_SOURCE_CHANGED`（A-11、A-12，
   错误码从真实响应体读出，不靠界面文案反推）；
5. 零副作用：新 `a.md` 仍在原路径且 SHA-256/字节数与替换后一致、
   目标 `renamed.md` 未创建、源没被搬走（A-13~A-15）；
6. **只发了一次**请求、零 `move` 请求（A-16、A-17）；
7. 输入行保留、状态栏如实说明「已被外部替换，未执行任何移动」（A-18、A-19）；
8. 取消 → 刷新 → 行锚变成新对象真正的锚（A-19a~A-21）；
9. 再次选中当前文件改名 → 200 `APPLIED`，磁盘真的搬了（A-22a~A-23）。

### 4.2 移动（B 段，27 项）

同一套断言走「移动到…」，另加两条：目标候选 `archive` 来自已加载层表（B-05）、
源仍原位字节一致且 `archive/notes.md` 未创建（B-10、B-11）。

### 4.3 这一轮被浏览器逼出来的两个真实缺陷

1. **嵌套文件的旧锚永久刷不掉**（B-14b 首轮 FAIL）。
   `toolbarTargetOf` 不带路径，「刷新当前目录」永远只重取**项目根层**；
   `docs/notes.md` 被外部替换后，那一层的旧锚没有任何界面途径能更新。
   修法：Host 明确 `ERR_ENTRY_SOURCE_CHANGED` / `ERR_RESOURCE_NOT_FOUND` 时，
   `StructureRunnerHost.onRejected` 把这个事实交回 Shell，Shell 只重取**源父层**。
   修完之后 `notesRowAfterRefresh.row === hostAnchorAfterReplace`，B 段全绿。

2. **脚本自己把"没发请求"当成了"发了被拒"**（A-22 首轮 FAIL）。
   `waitResponses` 超时后会返回**已有**响应，于是第二次提交没发出时读到的是第一次的
   409。改成先 `waitPosts` 等请求条数真的增加，再读响应（A-22b、A-22c、B-15a、B-15b）。
   这条记录留下来，是因为"证据脚本也会骗人"值得写进 notes。

### 4.4 另外一个被记录、但**本轮不修**的既有行为

提交期间输入框 `disabled`，焦点会掉到 body；结果回来后组件不再重新聚焦
（`InlineNamingRow` 的 focus 只在挂载时做一次）。对话框的 Escape 处理挂在
`dialog` 的 `onKeyDown` 上，需要焦点在对话框内，点击「确认移动」后同样失效。

于是"被拒之后直接按 Escape / Enter"不会有效果。这是**本轮之前就存在**的交互细节
（`InlineCreateRow.tsx` / `MoveEntryDialog.tsx` 本轮未改，`git diff` 可证），
已是 `docs/33` §8 的 `R2-R4`。

脚本因此走界面上真实存在的「×」/「取消（Esc）」按钮——取消会卸载输入行，
再打开是新的挂载，焦点与 Enter 都恢复。两次 Escape 无效的事实本身
（`escapeWhileFocusLost`、`escapeWhileFocusLostMove`）作为 FACT 记在
`browser-verification.json` 里，没有伪装成通过。

### 4.5 证据强度

- `sourceAnchor` 从 CDP 抓的真实 POST 请求体读出，不从行属性推断；
- 拒绝码来自 `Network.getResponseBody` 的真实响应体；
- 磁盘事实用 **SHA-256 + 字节数 + inode** 三元组比对，不用 `existsSync` 这种弱判据；
- "界面没有被刷新过"是被断言的**前提**（A-07：行上仍是旧锚），不是假设。

---

## 五、门禁

| 门禁 | 结果 |
|---|---|
| `npm run test:p0` | **1523 例 / 1521 通过 / 0 失败 / 2 跳过** |
| `npm run typecheck` | 0 |
| `npm run typecheck:apps` | 0 |
| `npm run build:shell` | ok（495.28 kB / gzip 149.54 kB） |
| `git diff --check` | 0 |

套件 110 自身 43 例全绿，套件 73 12 例全绿。

---

## 六、未覆盖 / 残余风险

见 `docs/33` §8。补充两条与证据相关的：

1. **`dev:ino` 复用**：探针与浏览器都只能证明"核验时刻不是同一个对象"，
   不能证明"两个时刻一定是同一个对象"。所有拒绝都是保守拒绝。
2. **第二处核验到 `rename(2)` 之间的 TOCTOU** 仍在（原子窗口之外的最后一次读）。
   `I-07` / `I-08` 用真实文件系统在钩子里替换/删除源，证明的是"钩子时刻之后的
   替换会被拦下"，不是"任何时刻的替换都会被拦下"。
