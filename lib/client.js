/**
 * dsh-settings-extras — 浏览器半侧。
 *
 * 向「设置 → 通用设置」的 `settings.general.item` 插槽贡献两行：
 *   1. 自动压缩阈值滑块（0.1 ~ 1.0，步进 0.05）
 *   2. 默认思考等级滑块（off / minimal / low / medium / high / xhigh / max 七档）
 *
 * 两个值都存在本插件的 Host 配置里（volatile 字段），因此读写走官方设置通道
 * `ctx.configForms.get('<Loader 行 id>')` → `remote.settings.mutate`，由 Host 落盘
 * 到 profile 的配置文档。真正的「生效」由 Host 半侧完成（推送预设阈值 / 请求换档）。
 *
 * 注入面约定（关键）：渲染层会把注入面里的 `hooks` 键**整个摘掉**，并把每个
 * `hooks.<name>` 变成名为 `use<Name>` 的 uSES 选择器钩子（见
 * ui-renderer/src/client/scoped-slots.tsx:183-229 与
 * ui-slots/src/renderer.ts:42 的 standardHookPropName）。所以组件只能通过
 * `useX(selector)` 读状态；直接读 `props.hooks` 会拿到 undefined、在渲染时抛错，
 * 结果是被 SlotCore 以 abdicate 摘掉该行（表现为插槽里 active: false）。
 *
 * 依赖策略：只 require 平台种子模块（react/jsx-runtime），不 import 任何
 * `@deepseek-ai/dsh-client-*` 包；样式只用 `--dsw-*` 主题 token，使 DSH 升级最多
 * 导致外观降级，而不会让本插槽条目崩掉。
 */

window.__ModuleLoader__.load({
    id: "dsh-settings-extras",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        const React = require("react");
        const { jsx, jsxs } = require("react/jsx-runtime");

        //#region 常量
        /** Loader 行 id：同时是设置通道的命名空间。 */
        const CONFIG_NS = "dsh-settings-extras";
        /** 本插件拥有的文案字典命名空间。 */
        const LOCALE_NS = "settings.settingsExtras";

        /** 适配器自有的档位名空间（由低到高）。 */
        const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

        /** form.set 返回 false 时的内部标记，用于在界面上给出本地化提示。 */
        const WRITE_REJECTED = "settings-write-rejected";

        /**
         * 压缩阈值滑块范围与步进。
         * 上限 0.95 是安全余量：取 1.0 时触发点等于压力预算上限
         * （floor(min(W×ratio, W−reserved−headroom))），容易在压缩前先撞上 provider
         * 的上下文上限。
         * 下限 0.2 是为了高于 retainRatio 的默认值 0.16：compaction-basic 要求
         * retainRatio < thresholdRatio，否则预设会在加载期直接拒绝。
         */
        const RATIO_MIN = 0.2;
        const RATIO_MAX = 0.95;
        const RATIO_STEP = 0.05;

        /** 两个偏好字段的兜底值，与 Host 侧 Config 的 default 保持一致。 */
        const FALLBACK_THRESHOLD = 0.5;
        const FALLBACK_EFFORT = "high";
        //#endregion

        //#region 文案
        const zh = {
            "compact.title": "自动压缩阈值",
            "compact.description": "上下文占用达到窗口的这个比例时触发自动压缩。会写入所有 Agent 预设，新建会话生效。",
            "compact.value": "{percent}%",
            "effort.title": "默认思考等级",
            "effort.description": "未手动指定档位时使用。模型不支持该档位时自动升到更高一档，没有更高档则取该模型最高档。",
            "effort.level.off": "Off",
            "effort.level.minimal": "Minimal",
            "effort.level.low": "Low",
            "effort.level.medium": "Medium",
            "effort.level.high": "High",
            "effort.level.xhigh": "XHigh",
            "effort.level.max": "Max",
            "error.write": "保存失败：{message}",
            "error.rejected": "Host 拒绝了这次写入",
        };

        const en = {
            "compact.title": "Auto-compact threshold",
            "compact.description": "Compacts automatically once context use reaches this fraction of the window. Written to every Agent preset; applies to new sessions.",
            "compact.value": "{percent}%",
            "effort.title": "Default reasoning effort",
            "effort.description": "Used when no level is chosen explicitly. A model that lacks the level escalates to the next higher one, or to its own highest.",
            "effort.level.off": "Off",
            "effort.level.minimal": "Minimal",
            "effort.level.low": "Low",
            "effort.level.medium": "Medium",
            "effort.level.high": "High",
            "effort.level.xhigh": "XHigh",
            "effort.level.max": "Max",
            "error.write": "Save failed: {message}",
            "error.rejected": "Host rejected this write",
        };
        //#endregion

        //#region 样式（只用主题 token）
        const S = {
            row: {
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "16px 0",
                borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
            },
            rowText: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
            title: { fontSize: "14px", lineHeight: "22px", color: "var(--dsw-alias-label-primary)" },
            desc: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
            control: { display: "flex", alignItems: "center", gap: "12px", minWidth: 0 },
            range: { flex: 1, minWidth: 0, height: "20px", accentColor: "var(--dsw-alias-brand-primary)", cursor: "pointer" },
            readout: {
                flex: "0 0 auto",
                minWidth: "56px",
                textAlign: "right",
                fontSize: "12px",
                lineHeight: "18px",
                color: "var(--dsw-alias-label-primary)",
                fontVariantNumeric: "tabular-nums",
            },
            ticks: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-caption)" },
            error: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-error)" },
        };
        //#endregion

        //#region 状态源
        /**
         * 极简快照存储：满足渲染层 observableHook 所需的 subscribe/getSnapshot。
         * getSnapshot 在未变更时必须返回同一引用，否则 uSES 会无限重渲染。
         */
        function createStore(initial) {
            let state = initial;
            const listeners = new Set();
            return {
                getSnapshot: () => state,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                    };
                },
                set: (next) => {
                    state = next;
                    for (const listener of [...listeners]) listener();
                },
            };
        }

        /**
         * 拖动期间只改本地草稿，停手后（delay 毫秒内无新动作）才提交一次写入。
         * 否则 range 的每个步进都会发一次设置写入，而每次写入都会走完整落盘 +
         * Loader 协调，表现为滑块不跟手。
         * 提交后仍以草稿为准，直到 store 的值追上草稿才交还控制权，避免读数回跳。
         * 提交失败时回滚草稿并返回错误文案：否则滑块会停在用户拖动的位置，
         * 看起来像是保存成功，重新进入设置页才暴露真实值。
         */
        function useDraftCommit(committed, commit, delay) {
            const [draft, setDraft] = React.useState(null);
            const [error, setError] = React.useState(null);
            const timer = React.useRef(null);
            const cancel = () => {
                if (timer.current !== null) {
                    clearTimeout(timer.current);
                    timer.current = null;
                }
            };
            React.useEffect(() => cancel, []);
            React.useEffect(() => {
                if (draft !== null && draft === committed) setDraft(null);
            }, [committed, draft]);
            const change = (next) => {
                setDraft(next);
                setError(null);
                cancel();
                timer.current = setTimeout(() => {
                    timer.current = null;
                    Promise.resolve()
                        .then(() => commit(next))
                        .catch((reason) => {
                            setDraft(null);
                            setError(reason instanceof Error ? reason.message : String(reason));
                        });
                }, delay);
            };
            return [draft === null ? committed : draft, change, error];
        }
        //#endregion

        //#region 组件
        /** 滑块行：标题 + 说明 + range + 读数；不可写时整体禁用。 */
        function SliderRow(props) {
            const { t, spec, ticks } = props;
            const state = props.useSettingsExtras((value) => value);
            const settings = state && state.value ? state.value : {};
            const raw = settings[spec.field];
            const committed = typeof raw === "number" ? raw : spec.fallback;
            const [current, drag, error] = useDraftCommit(committed, spec.onChange, 250);
            const disabled = state.status !== "ready" || state.writable === false;

            return jsxs("div", {
                style: S.row,
                children: [
                    jsxs("div", {
                        style: S.rowText,
                        children: [
                            jsx("div", { style: S.title, children: t(spec.titleKey) }),
                            jsx("div", { style: S.desc, children: t(spec.descKey) }),
                        ],
                    }),
                    jsxs("div", {
                        style: S.control,
                        children: [
                            jsx("input", {
                                type: "range",
                                style: S.range,
                                min: spec.min,
                                max: spec.max,
                                step: spec.step,
                                value: current,
                                disabled,
                                "aria-label": t(spec.titleKey),
                                onChange: (event) => {
                                    drag(Number(event.target.value));
                                },
                            }),
                            jsx("span", {
                                style: S.readout,
                                children: t("compact.value", { percent: Math.round(current * 100) }),
                            }),
                        ],
                    }),
                    jsx("div", { style: S.ticks, children: ticks }),
                    error !== null && jsx("div", {
                        style: S.error,
                        children: t("error.write", {
                            message: error === WRITE_REJECTED ? t("error.rejected") : error,
                        }),
                    }),
                ],
            });
        }

        /** 档位行：以离散滑块呈现七档，读数为档位名。 */
        function EffortRow(props) {
            const { t } = props;
            const state = props.useSettingsExtras((value) => value);
            const settings = state && state.value ? state.value : {};
            const raw = settings.defaultReasoningEffort;
            const committed = typeof raw === "string" && LEVELS.includes(raw) ? raw : FALLBACK_EFFORT;
            const [index, drag, error] = useDraftCommit(LEVELS.indexOf(committed), async (next) => {
                const level = LEVELS[next];
                if (level === undefined) return;
                if (!await props.setEffort(level)) throw new Error(WRITE_REJECTED);
            }, 250);
            const current = LEVELS[index] === undefined ? committed : LEVELS[index];
            const disabled = state.status !== "ready" || state.writable === false;

            return jsxs("div", {
                style: S.row,
                children: [
                    jsxs("div", {
                        style: S.rowText,
                        children: [
                            jsx("div", { style: S.title, children: t("effort.title") }),
                            jsx("div", { style: S.desc, children: t("effort.description") }),
                        ],
                    }),
                    jsxs("div", {
                        style: S.control,
                        children: [
                            jsx("input", {
                                type: "range",
                                style: S.range,
                                min: 0,
                                max: LEVELS.length - 1,
                                step: 1,
                                value: index,
                                disabled,
                                "aria-label": t("effort.title"),
                                onChange: (event) => {
                                    drag(Number(event.target.value));
                                },
                            }),
                            jsx("span", { style: S.readout, children: t("effort.level." + current) }),
                        ],
                    }),
                    jsx("div", {
                        style: S.ticks,
                        children: LEVELS.map((level) => t("effort.level." + level)).join(" · "),
                    }),
                    error !== null && jsx("div", {
                        style: S.error,
                        children: t("error.write", {
                            message: error === WRITE_REJECTED ? t("error.rejected") : error,
                        }),
                    }),
                ],
            });
        }
        //#endregion

        //#region 插件入口
        const inject = ["slots", "locale", "configForms"];

        function apply(ctx) {
            const t = ctx.locale.bind(LOCALE_NS);
            ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-settings-extras: dictionaries");

            const form = ctx.configForms.get(CONFIG_NS);
            const state = createStore({ status: "loading", value: undefined, writable: false });
            const sync = () => {
                const snapshot = form.getSnapshot();
                state.set({
                    status: snapshot.status,
                    value: snapshot.value,
                    writable: snapshot.writable !== false,
                });
            };
            ctx.effect(() => form.subscribe(sync), "dsh-settings-extras: preference adoption");
            sync();

            /**
             * 写入一个字段；首次被拒后重试一次。
             * form.set 在 Host 拒绝时会先重读最新文档再返回 false（多见 revision 过期），
             * 此时用刷新后的 revision 再写一次即可成功；其它拒绝原因第二次同样失败，
             * 由调用方把错误显示出来。
             */
            const setField = async (field, value) => {
                if (await form.set(field, value)) return true;
                return form.set(field, value);
            };

            // 注入面只构造一次：对象身份稳定，渲染层对该注入面的绑定才可缓存。
            const face = {
                hooks: { settingsExtras: state },
                setEffort: (level) => setField("defaultReasoningEffort", level),
            };

            ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
                name: "settings.general.item",
                id: "auto-compact-threshold",
                order: 30,
                locale: LOCALE_NS,
                inject: () => face,
            }, (props) => jsx(SliderRow, {
                ...props,
                spec: {
                    field: "compactionThreshold",
                    fallback: FALLBACK_THRESHOLD,
                    min: RATIO_MIN,
                    max: RATIO_MAX,
                    step: RATIO_STEP,
                    titleKey: "compact.title",
                    descKey: "compact.description",
                    onChange: (next) => setField("compactionThreshold", next).then((ok) => {
                        if (!ok) throw new Error(WRITE_REJECTED);
                    }),
                },
                ticks: [
                    t("compact.value", { percent: Math.round(RATIO_MIN * 100) }),
                    " — ",
                    t("compact.value", { percent: Math.round(RATIO_MAX * 100) }),
                ].join(""),
            }))), "dsh-settings-extras: compact row");

            ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
                name: "settings.general.item",
                id: "default-reasoning-effort",
                order: 31,
                locale: LOCALE_NS,
                inject: () => face,
            }, EffortRow)), "dsh-settings-extras: effort row");
        }

        exports.NS = LOCALE_NS;
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
