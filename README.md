# toonflow-assistant

Toonflow-app 工作目录的命令行管理与素材优化工具：体检、一致性检查、快照回滚、清理、导出、会话统计，以及用火山方舟文本模型优化故事大纲、剧本、角色/场景设定、分镜稿和生成提示词。

写回工作目录的内容遵循 Toonflow 的持久化格式（画布 JSON + `assets/{节点ID}/content.md`），重新打开画布即可被 APP 正确加载。

## 安装

需要 [Bun](https://bun.sh) ≥ 1.3；使用 shuohao-skills 还需要 Node.js ≥ 18。

```sh
git clone --recurse-submodules https://github.com/shyguochao/toonflow-assistant.git
cd toonflow-assistant
# 已经 clone 但没带 submodule 时：git submodule update --init
bun install
bun link            # 之后可直接使用 tfa；也可以用 bun run src/cli.ts 代替
export TFA_WORKSPACE=/path/to/your-workspace   # 可选：省略每条命令里的工作目录
```

### 第三方 Skill：shuohao-skills

`vendor/shuohao-skills` 是 git submodule，指向 fork [shyguochao/shuohao-skills](https://github.com/shyguochao/shuohao-skills)（上游 [eternityspring/shuohao-skills](https://github.com/eternityspring/shuohao-skills)，Apache-2.0），锁定在提交 `af54a67`。包含短剧制作 Skill：novel-outline、novel-characters、novel-art、novel-script、novel-staging、novel-storyboard、character-refs，以及本 fork 新增的 toonflow-canvas（把前面的产出转成 Toonflow 原生画布）。

升级到新的上游版本：

```sh
cd vendor/shuohao-skills
git remote add upstream https://github.com/eternityspring/shuohao-skills.git   # 只需一次
git fetch upstream && git merge --ff-only upstream/main && git push origin main  # 同步 fork
cd ../.. && git add vendor/shuohao-skills && git commit -m "vendor: bump shuohao-skills"
```

不要直接修改 `vendor/` 下的文件：fork 的改动在 fork 仓库里提交、推送后再前移 submodule 指针，并同步 `src/shuohao/vendor.ts` 的 `pinnedCommit`。许可信息见 `NOTICE`。

## 命令

| 命令 | 作用 | 修改文件 |
|---|---|---|
| `tfa inspect [ws]` | 画布、节点、素材目录、会话的结构化清单 | 否 |
| `tfa lint [ws]` | 断链、缺失正文/媒体、坏的 model 字段、`{{ref N}}` 越界、孤儿目录等（有 error 时退出码 1） | 否 |
| `tfa snapshot [ws] [-m 备注] [--with-sessions]` | 拍快照 | 只写快照目录 |
| `tfa snapshots [ws]` | 列出快照 | 否 |
| `tfa restore [ws] <ID> [--apply]` | 回滚（回滚前会先给当前状态拍快照） | 是 |
| `tfa clean [ws] [--apply]` | 删除没有节点引用的 `assets/<uuid>/` 目录 | 是 |
| `tfa export [ws] [--out 目录] [--format md\|docx]` | 每个文本节点导出为 Markdown，并生成 `index.md`；`docx` 需本机 pandoc | 否 |
| `tfa sessions [ws]` | Agent 会话轮次、工具调用、报错、模型、token | 否 |
| `tfa optimize [ws] --node <ID\|标签> --as <类型> [--goal 要求] [--mode replace\|new-node] [--apply]` | 用火山方舟优化素材 | 是 |
| `tfa import [ws] --from shuohao/<剧名>-<类型>.json [--node ID\|标签] [--label 标签] [--force] [--apply]` | 校验 shuohao 数据后写入：`-toonflow.json` 合并为原生画布，其余类型渲染成文本节点 | 是 |
| `tfa setup-skills [--target 目录] [--with character-refs] [--apply]` | 把 vendor 里的 skill 链接到 Comate 项目级 skills 目录 | 是 |
| `tfa doctor [--selftest]` | 检查 submodule、锁定版本、node、skill 链接 | 否 |

所有命令支持 `--json` 输出。

### optimize 类型

| `--as` | 输入节点 | 产出 | 默认写回 |
|---|---|---|---|
| `outline` | 文本节点（大纲） | 优化后的故事大纲 | `replace`：覆盖原节点正文 |
| `script` | 文本节点（剧本） | 场次、时长、画内文字齐全的剧本 | `replace` |
| `character` | 剧本/大纲节点，`--goal` 写角色名 | 角色设定卡 + 四视角参考板提示词 | `new-node`：新建节点 |
| `scene` | 剧本/大纲节点，`--goal` 写场景名 | 场景设定卡 + 主视图提示词 | `new-node` |
| `storyboard` | 剧本节点 | 分镜表 + 资产清单 | `new-node` |
| `prompt` | 图片/视频生成节点 | 按 Seedream/Seedance 规范改写的提示词，参考引用保持不变 | 改该节点的 prompt |

同画布其他文本节点（简报、大纲、剧本）会作为上下文一并发给模型。规范提炼自 Toonflow-app 自带的 workflow 技能（MIT，© HBAI-Ltd），见 `src/standards/index.ts`。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARK_API_KEY` | （必填） | 火山方舟控制台 → API Key 管理（按量付费 Key，不要用 Agent Plan / Coding Plan 的 Key） |
| `ARK_MODEL` | `glm-5-3-flash-260828` | 方舟控制台「开通管理」中的模型 ID |
| `ARK_REASONING` | `high` | GLM-5.3-Flash 思考强度：`low` / `high` / `max` |
| `ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | 其他地域可覆盖；拒绝 `/api/plan` |

## 在 Comate 对话中产出 Toonflow 原生画布

1. 一次性准备：`tfa setup-skills --apply`，再 `tfa doctor` 全部 ✓；新开一个 Comate 会话，skill 列表里能看到 novel-* 与 toonflow-canvas。
2. 在对话里让 novel-outline / novel-characters / novel-art / novel-script / novel-storyboard 生成或修改数据，文件放在 `<工作目录>/shuohao/<剧名>-<类型>.json`，每个 skill 自带的 validate 必须通过。
3. 要转分镜时先导出 Seedance 投产包：`node <novel-storyboard>/scripts/novel-storyboard.mjs export <剧名>-storyboard.json --script <剧名>-script.json --protocol seedance --out seedance`。
4. 让 toonflow-canvas 转换：`node <toonflow-canvas>/scripts/toonflow-canvas.mjs build shuohao [--seedance shuohao/seedance]`，产出 `shuohao/<剧名>-toonflow.json`。
5. 停掉 Toonflow 后导入：`tfa import <工作目录> --from shuohao/<剧名>-toonflow.json` 预览，确认后加 `--apply`；`tfa lint` 无 error。
6. 打开 Toonflow：`画布/剧本.json`（大纲与每集剧本）、`画布/资产.json`（角色/场景/道具图片生成节点）、`画布/分集/第NNN集.json`（每段视频生成节点，已连好参考图）。

再次转换、导入时只更新托管字段（标签、提示词、正文、引用顺序、时长、比例），节点位置、模型、已生成的图片视频和你手动加的节点保持不变；资产出图后，分集画布的引用节点会自动指向同一张图。导入后在 APP 里改过的提示词或正文会被 `tfa lint` 标出，再次导入会拒绝覆盖，确认后加 `--force`。tfa 不会删除节点：bundle 里去掉的节点只提示，由你在 APP 里删除。

不经过 toonflow-canvas 时，也可以把单个 JSON 渲染成文本节点：`tfa import --from shuohao/<剧名>-outline.json --node 故事大纲`。

## 安全策略

- **默认只预览**：打印将修改的文件和 diff，加 `--apply` 才写入。
- **写前自动快照**：保存在本仓库 `.snapshots/<工作目录名>/<时间>/`（工作目录之外，APP 不会扫描到），用 `tfa restore` 回滚。
- **APP 运行检测**：要改画布 JSON 时，若 `127.0.0.1:3000` 上的 Toonflow 服务在运行会拒绝执行，因为画布打开时 APP 会自动保存并覆盖外部修改。请先在 APP 关闭画布并停止服务，或确认画布未打开后加 `--force`。只改正文文件时只给提示。
- **并发保护**：预览后文件若被改动（例如 APP 自动保存），写入会中止。
- **写后校验**：写入后重新运行检查，出现新的 error 自动回滚。
- Toonflow 没有文件监听，**写入后需在 APP 中重新打开画布**才能看到变化。

## 示例

```sh
tfa inspect ../your-workspace
tfa lint ../your-workspace
tfa optimize ../your-workspace --node 故事大纲 --as outline          # 预览
tfa optimize ../your-workspace --node 故事大纲 --as outline --apply  # 写入
tfa optimize ../your-workspace --node 第一集剧本 --as character --goal 主角名 --apply
tfa snapshots ../your-workspace
tfa restore ../your-workspace 20261028-120000-000 --apply
```

## 开发

```sh
bun test           # 用 test/fixtures/sample-workspace 的只读拷贝测试，LLM 调用使用本地桩
bun run typecheck
```

节点模板来自 Toonflow-app `af6e884`（2026-10-27），见 `src/workspace/templates.ts`。Toonflow 升级后若持久化格式变化，先更新模板再写入。
