# UX-02C-05-R1.1 证据目录

真实 Chrome + 真实 Host + 独立 Workspace（`D:/Workspace/projects/weavespace-test/c05-r11`）。
本轮只改 Shell 侧的身份判定与会话归属 + Host 的**能力声明**，没有新增文件系统能力。

## 1. 先红后绿

| 文件 | 内容 |
|---|---|
| `red-suite-108.txt` | 套件 108 在**旧实现**上的原始输出：24 例 → 11 pass / **13 fail** |
| `green-suite-106-107-108.txt` | 修复后 106+107+108：**87/87 pass** |

红测失败的 13 例：A01、A02（残响）、B01、B02、B03、B04、B07、B09（身份三态）、
C01、C02、C03、C04、C05（异步会话）。其余 11 例是"本来正确、本轮防回归"的用例
（A03/A04/A05、B05/B06/B08、D01–D05）。

## 2. 真实浏览器（`browser-verification.json`）

25/25 PASS。关键事实（脚本原样记录，不是手写）：

```json
"identityBefore": { "support": "supported", "anchor": "78705da34272f003155de4f610d1e360" }
"identityAfter":  { "support": "supported", "anchor": "1110a9257e640fee80aa4140ae294ca2" }
"clickSequenceReplace": [
  { "type": "click", "detail": 1, "name": "note.md", "at": 3412 },
  { "type": "click", "detail": 2, "name": "note.md", "at": 3749 },
  { "type": "dblclick", "detail": 2, "name": "note.md", "at": 3750 }
]
"gapMs": 337
```

场景顺序：第一次点击（`detail=1`）→ 500ms 窗口内删除并重建同路径文件（换 inode）→
点工具栏刷新（真实请求 `/api/tree`）→ 拿到新锚 → 第二下带 `detail=2` 打在同一行。

结论（V-11 ~ V-15）：没有进入活动 View、没有打开改名输入行、**零** `/api/open`、
**零** `/api/files/rename`、磁盘 inode 与大小未变。

截图：

- `01-residual-detail2.png` —— 残响之后仍然是"还没有打开文档"，行上没有已打开圆点；
- `02-normal-double-click.png` —— 紧接着的正常 300ms 双击仍然进入改名（修复没打死正常路径）；
- `03-single-click-opens.png` —— 正常单击仍然打开；
- `04-project-root-rename.png` —— 项目根双击仍然进入显示名编辑（根行未被身份检查误伤）；
- `05-root-single-click.png` —— 项目根单击仍然切换当前项目。

## 3. 变异探针（`mutations.json`）

| 探针 | 改坏什么 | 咬住 |
|---|---|---|
| C05R11-M7 | `armed=null` 时仍接受 `detail≥2` 并设成新起点 | A01、A02 |
| C05R11-M8 | `identityVerificationOf` 把无锚一律降级成 `unsupported` | B02 |
| C05R11-M9 | `stillSame` 不再看身份状态（unverified 参与相等推断） | B03、B04 |
| C05R11-M10 | 会话归属不比对工作区 | C02 |
| C05R11-M11 | 会话归属不比对活动项目 | C01 |

五个探针全部 `BITTEN`，`sourceChanged` 与 `restoreExact` 全为 `true`
（逐字节还原，SHA-256 与基线一致）。

## 4. 门禁

| 项 | 结果 | 文件 |
|---|---|---|
| 套件 106+107+108 | PASS 87/87 | `green-suite-106-107-108.txt` |
| `npm run test:p0` | PASS 1445 例 / 1443 pass / 0 fail / 2 skip | `gate-test-p0.txt` |
| `npm run typecheck` | PASS | `gate-typecheck-build.txt` |
| `npm run typecheck:apps` | PASS（shell + server） | 同上 |
| `npm run build:shell` | PASS（built in 2.07s） | 同上 |
| `git diff --check` | PASS（exit 0） | 同上 |
| 真实 Chrome | PASS 25/25 | `browser-verification.json` |
| 变异探针 | PASS 5/5 BITTEN | `mutations.json` |

## 5. 取证踩坑（本轮新增）

1. **残响场景必须在 500ms 窗口内完成"替换 + 刷新"**：实测页面计时 337ms（墙钟 463ms），
   才能让浏览器真的把第二下报成 `detail=2`。为了不让刷新点击打断连击计数，
   刷新用工具栏按钮（不同位置不影响 CDP 显式 `clickCount`，但真实间隔必须保住）。
2. **等待刷新落地的信号用 `/api/tree` 的响应事件**，不要靠固定 sleep：
   响应到达后 40ms 再打第二下，既稳定又不把间隔拖出窗口。
3. **锚的变化要独立核对**：直接向 Host 再要一页树（`x-ws-token`）比在页面里猜更可靠；
   同时用 `lstat().ino` 证明"删除重建"真的换了对象（原地覆盖写不换 inode，锚不变）。
4. **D06 的旧夹具依赖了本轮要修的缺陷**：它直接发两次 `click(2)`（没有第一次点击）。
   R1.1 起一段手势必须由 `detail=1` 开始，因此把它改成合法的两段手势，
   **断言本身一条未改**（仍是 `{single:0, double:2}`）。
