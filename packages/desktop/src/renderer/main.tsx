import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { createRoot } from "react-dom/client";
import type { ConfigSnapshot, DesktopStatus, RuntimeEvent, RuntimeMetrics } from "./desktop";
import "./styles.css";

type Notice = { tone: "success" | "error" | "neutral"; message: string } | null;
type Config = Record<string, unknown>;
type ModelEntry = string | (Config & { name: string; alias?: string | string[] });
type Provider = Config & {
  name: string;
  api: string;
  api_base_url: string;
  api_key: string;
  models: ModelEntry[];
  max_concurrency?: number;
  context_length?: number;
};
type ModelMapping = {
  name: string;
  aliases: string[];
  metadata: Config;
  preserveObject: boolean;
  requiresAlias: boolean;
};
type Page = "overview" | "config";

const phaseLabel: Record<DesktopStatus["phase"], string> = {
  stopped: "已停止",
  starting: "正在启动",
  running: "运行中",
  failed: "需要处理",
};

const isRecord = (value: unknown): value is Config =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const nameOf = (value: ModelEntry) =>
  typeof value === "string" ? value : value.name || "未命名模型";

const aliasesOf = (value: ModelEntry): string[] => {
  if (typeof value === "string" || !value.alias) return [];
  return Array.isArray(value.alias) ? value.alias : [value.alias];
};

const modelSummary = (models: ModelEntry[]) =>
  models
    .map((model) => {
      const aliases = aliasesOf(model);
      return aliases.length ? `${aliases.join(", ")} → ${nameOf(model)}` : nameOf(model);
    })
    .join(" · ");

const modelMappingsOf = (models: ModelEntry[]): ModelMapping[] =>
  models.map((entry) => {
    if (typeof entry === "string") {
      return {
        name: entry,
        aliases: [],
        metadata: {},
        preserveObject: false,
        requiresAlias: false,
      };
    }

    const { name, alias, ...metadata } = entry;
    return {
      name,
      aliases: aliasesOf(entry),
      metadata,
      preserveObject: true,
      requiresAlias: false,
    };
  });

const modelEntriesOf = (mappings: ModelMapping[]): ModelEntry[] =>
  mappings.map(({ name, aliases, metadata, preserveObject }) => {
    const normalizedName = name.trim();
    const normalizedAliases = aliases.map((alias) => alias.trim()).filter(Boolean);
    if (!preserveObject && normalizedAliases.length === 0) return normalizedName;

    return {
      ...metadata,
      name: normalizedName,
      ...(normalizedAliases.length === 1
        ? { alias: normalizedAliases[0] }
        : normalizedAliases.length > 1
          ? { alias: normalizedAliases }
          : {}),
    };
  });

const emptyModelMapping = (): ModelMapping => ({
  name: "",
  aliases: [""],
  metadata: {},
  preserveObject: true,
  requiresAlias: true,
});

const parseAliases = (value: string) => value.split(",").map((alias) => alias.trim());

const hostOf = (value: string) => {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "");
  }
};

const mask = (value: string) =>
  value === "[configured]"
    ? "已配置"
    : value
      ? `${value.slice(0, 4)}****${value.slice(-4)}`
      : "未配置";

const providerOf = (value: unknown): Provider | null => {
  if (!isRecord(value) || typeof value.name !== "string") return null;

  return {
    ...value,
    name: value.name,
    api: typeof value.api === "string" ? value.api : "OpenAI",
    api_base_url: typeof value.api_base_url === "string" ? value.api_base_url : "",
    api_key: typeof value.api_key === "string" ? value.api_key : "",
    models: Array.isArray(value.models) ? (value.models as ModelEntry[]) : [],
  };
};

const formatNumber = (value: number) =>
  value === 0
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);

const configuredModelNames = (provider: Provider) =>
  provider.models.flatMap((model) => [nameOf(model), ...aliasesOf(model)]);

const validateModelMappings = (
  mappings: ModelMapping[],
  otherProviders: Provider[],
): string | null => {
  const actualNames = new Set<string>();
  for (const mapping of mappings) {
    const name = mapping.name.trim();
    if (!name) return "每个模型都必须填写上游模型名。";
    actualNames.add(name.toLocaleLowerCase());
    if (mapping.requiresAlias && !mapping.aliases.some((alias) => alias.trim())) {
      return `模型“${name}”必须填写 CCR 模型别名。`;
    }
  }

  const occupiedNames = new Map<string, string>();
  for (const provider of otherProviders) {
    for (const name of configuredModelNames(provider)) {
      const normalized = name.trim().toLocaleLowerCase();
      if (normalized) occupiedNames.set(normalized, `供应商“${provider.name}”`);
    }
  }

  const localAliases = new Set<string>();
  for (const mapping of mappings) {
    for (const alias of mapping.aliases) {
      const normalizedAlias = alias.trim().toLocaleLowerCase();
      if (!normalizedAlias) continue;
      if (actualNames.has(normalizedAlias)) {
        return `别名“${alias.trim()}”不能与上游模型名相同。`;
      }
      if (localAliases.has(normalizedAlias)) {
        return `别名“${alias.trim()}”在当前配置中重复。`;
      }
      const occupiedBy = occupiedNames.get(normalizedAlias);
      if (occupiedBy) {
        return `别名“${alias.trim()}”已被${occupiedBy}占用。`;
      }
      localAliases.add(normalizedAlias);
    }
  }

  return null;
};

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [status, setStatus] = useState<DesktopStatus>({
    phase: "starting",
    endpoint: "http://127.0.0.1:3456",
  });
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [config, setConfig] = useState<Config>({});
  const [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [expandedRuntimeEvents, setExpandedRuntimeEvents] = useState<Set<number>>(() => new Set());
  const [runtimeMetrics, setRuntimeMetrics] = useState<RuntimeMetrics | null>(null);
  const [protocol, setProtocol] = useState("all");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<Provider | null>(null);
  const [draftMappings, setDraftMappings] = useState<ModelMapping[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);

  const refreshStatus = useCallback(
    async () => setStatus(await window.desktop.getStatus()),
    [],
  );
  const refreshRuntimeEvents = useCallback(async () => {
    try {
      setRuntimeEvents((await window.desktop.getRuntimeEvents()).events);
    } catch {
      /* 服务可能正在重启。 */
    }
  }, []);
  const toggleRuntimeEvent = (eventId: number) => {
    setExpandedRuntimeEvents((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };
  const refreshRuntimeMetrics = useCallback(async () => {
    try {
      const next = (await window.desktop.getRuntimeMetrics()).metrics;
      if (next) setRuntimeMetrics(next);
    } catch {
      /* 服务可能正在重启。 */
    }
  }, []);
  const load = useCallback(async () => {
    try {
      const next = await window.desktop.getConfig();
      setSnapshot(next);
      setConfig(isRecord(next.config) ? next.config : {});
    } catch (error) {
      setNotice({ tone: "error", message: `无法读取配置：${String(error)}` });
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshRuntimeEvents();
    void refreshRuntimeMetrics();
    void load();
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshRuntimeEvents();
      void refreshRuntimeMetrics();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [load, refreshRuntimeEvents, refreshRuntimeMetrics, refreshStatus]);

  const providers = useMemo(
    () =>
      (Array.isArray(config.Providers) ? config.Providers : [])
        .map(providerOf)
        .filter((item): item is Provider => item !== null),
    [config],
  );
  const router = isRecord(config.Router) ? config.Router : {};
  const filtered =
    protocol === "all"
      ? providers
      : providers.filter((provider) => provider.api.toLowerCase().includes(protocol));
  const running = status.phase === "running";

  const updateProviders = (next: Provider[]) =>
    setConfig((current) => ({ ...current, Providers: next }));
  const updateDraftMappings = (updater: (mappings: ModelMapping[]) => ModelMapping[]) => {
    setDraftMappings((current) => updater(current));
    setDraftError(null);
  };
  const execute = async (operation: () => Promise<DesktopStatus>) => {
    setBusy(true);
    try {
      setStatus(await operation());
    } finally {
      setBusy(false);
    }
  };
  const persistConfig = async (
    nextConfig: Config,
    restart: boolean,
    successMessage: string,
  ): Promise<boolean> => {
    if (!snapshot) return false;
    setBusy(true);
    try {
      const result = await window.desktop.saveConfig(nextConfig, snapshot.revision);
      setConfig(nextConfig);
      setSnapshot({
        config: nextConfig,
        revision: result.revision,
        sourceWillBeFormatted: result.sourceWillBeFormatted,
      });
      if (restart) setStatus(await window.desktop.restart());
      setNotice({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setNotice({ tone: "error", message: `保存失败：${String(error)}` });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (restart = false) =>
    persistConfig(config, restart, restart ? "配置已保存并重启服务。" : "配置已保存。");
  const openEditor = (index?: number) => {
    const current = typeof index === "number" ? providers[index] : undefined;
    setEditingIndex(current ? index! : null);
    setDraftError(null);
    const nextDraft = current
      ? clone(current)
      : {
          name: "",
          api: protocol === "anthropic" ? "Anthropic" : "OpenAI",
          api_base_url: "",
          api_key: "",
          models: [],
          max_concurrency: 50,
          context_length: 300000,
        };
    setDraft(nextDraft);
    setDraftMappings(modelMappingsOf(nextDraft.models));
  };
  const closeEditor = () => {
    setDraft(null);
    setDraftMappings([]);
    setDraftError(null);
  };
  const commitDraft = async () => {
    if (!draft?.name.trim()) {
      setDraftError("配置名称不能为空。");
      return;
    }

    const mappingError = validateModelMappings(
      draftMappings,
      providers.filter((_, index) => index !== editingIndex),
    );
    if (mappingError) {
      setDraftError(mappingError);
      return;
    }

    const nextDraft = {
      ...draft,
      models: modelEntriesOf(draftMappings),
    };
    const nextProviders = [...providers];
    if (editingIndex === null) nextProviders.push(nextDraft);
    else nextProviders[editingIndex] = nextDraft;
    const nextConfig = { ...config, Providers: nextProviders };
    if (await persistConfig(nextConfig, true, "模型已保存，CCR 已重启并加载新配置。")) {
      closeEditor();
    }
  };
  const remove = (index: number) =>
    updateProviders(providers.filter((_, current) => current !== index));
  const toggleMaximize = async () =>
    setMaximized(await window.desktop.toggleMaximizeWindow());

  return (
    <div className="app-shell">
      <header className="app-titlebar">
        <div className="brand">
          <span className="brand__mark">C</span> Claude Code Router
        </div>
        <div className="titlebar__right">
          <div className={`status status--${status.phase}`}>
            <span className="status__dot" />
            {phaseLabel[status.phase]}
          </div>
          <div className="window-controls">
            <button aria-label="最小化" onClick={() => void window.desktop.minimizeWindow()}>
              <Minus size={17} />
            </button>
            <button
              aria-label={maximized ? "还原窗口" : "最大化窗口"}
              onClick={() => void toggleMaximize()}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button
              aria-label="关闭到托盘"
              className="window-controls__close"
              onClick={() => void window.desktop.closeWindow()}
            >
              <X size={17} />
            </button>
          </div>
        </div>
      </header>

      <div className="app-body">
        <aside className="side-nav">
          <button
            className={page === "overview" ? "nav-item nav-item--active" : "nav-item"}
            onClick={() => setPage("overview")}
          >
            <LayoutDashboard size={18} />
            <span>总览</span>
          </button>
          <button
            className={page === "config" ? "nav-item nav-item--active" : "nav-item"}
            onClick={() => setPage("config")}
          >
            <Settings2 size={18} />
            <span>配置工作台</span>
          </button>
          <div className="nav-spacer" />
          <button className="nav-item" onClick={() => void window.desktop.openLogs()}>
            <FolderOpen size={18} />
            <span>日志目录</span>
          </button>
        </aside>

        <main className="page-scroll">
          {page === "overview" ? (
            <section className="page">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">LOCAL CONTROL PLANE</p>
                  <h1>服务总览</h1>
                  <p>CCR 的运行状态与请求指标会在这里汇总。</p>
                </div>
                <div className="page-actions">
                  {running ? (
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => void execute(() => window.desktop.stop())}
                    >
                      <Square size={16} />
                      停止服务
                    </button>
                  ) : (
                    <button
                      className="button button--primary"
                      disabled={busy}
                      onClick={() => void execute(() => window.desktop.start())}
                    >
                      <Play size={16} />
                      启动服务
                    </button>
                  )}
                  <button
                    className="button button--secondary"
                    disabled={busy}
                    onClick={() => void execute(() => window.desktop.restart())}
                  >
                    <RefreshCw size={16} />
                    重启
                  </button>
                </div>
              </div>

              <section className="metrics">
                <article>
                  <span>缓存命中率</span>
                  <strong>
                    {runtimeMetrics?.cacheHitRate == null
                      ? "—"
                      : `${(runtimeMetrics.cacheHitRate * 100).toFixed(2)}%`}
                  </strong>
                  <small>
                    {runtimeMetrics?.tokens.reportedRequests
                      ? `缓存读取 ${formatNumber(runtimeMetrics.tokens.cacheReadTokens)} Token`
                      : "等待上游返回 usage"}
                  </small>
                </article>
                <article>
                  <span>对话轮次</span>
                  <strong>{formatNumber(runtimeMetrics?.requests.total ?? 0)}</strong>
                  <small>
                    有效 {formatNumber(runtimeMetrics?.requests.successful ?? 0)} / 异常{" "}
                    {formatNumber(runtimeMetrics?.requests.failed ?? 0)}
                    {runtimeMetrics?.requests.active
                      ? ` / 进行中 ${formatNumber(runtimeMetrics.requests.active)}`
                      : ""}
                  </small>
                </article>
                <article>
                  <span>Token 消耗</span>
                  <strong>{formatNumber(runtimeMetrics?.tokens.totalTokens ?? 0)}</strong>
                  <small>
                    Prompt {formatNumber(runtimeMetrics?.tokens.promptTokens ?? 0)} / Completion{" "}
                    {formatNumber(runtimeMetrics?.tokens.completionTokens ?? 0)}
                  </small>
                </article>
                <article>
                  <span>价值估算</span>
                  <strong>—</strong>
                  <small>
                    未配置模型价格 · 缓存写入 {formatNumber(runtimeMetrics?.tokens.cacheWriteTokens ?? 0)} Token
                  </small>
                </article>
              </section>

              <section className="overview-grid">
                <article className="overview-card">
                  <div>
                    <span className="card-label">
                      <Activity size={16} />
                      服务状态
                    </span>
                    <strong>{phaseLabel[status.phase]}</strong>
                    <p>{running ? "健康检查已通过，CCR 可以接收请求。" : "服务状态由桌面端持续检测。"}</p>
                  </div>
                  <span className={`status status--${status.phase}`}>
                    <span className="status__dot" />
                    {phaseLabel[status.phase]}
                  </span>
                </article>
                <article className="overview-card">
                  <span className="card-label">本地端点</span>
                  <strong className="mono">{status.endpoint}</strong>
                  <p>{status.pid ? `进程 PID ${status.pid}` : "等待服务创建进程"}</p>
                </article>
                <article className="overview-card">
                  <span className="card-label">路由配置</span>
                  <strong>{providers.length} 个供应商</strong>
                  <p>默认路由：{typeof router.default === "string" && router.default ? router.default : "未配置"}</p>
                </article>
              </section>

              {status.lastError && (
                <section className="error-panel">
                  <TriangleAlert size={18} />
                  <div>
                    <strong>服务未能就绪</strong>
                    <p>{status.lastError}</p>
                  </div>
                </section>
              )}

              <section className="runtime-log">
                <header>
                  <div>
                    <p className="eyebrow">RUNTIME OBSERVABILITY</p>
                    <h2>运行时日志</h2>
                  </div>
                  <span>{runtimeEvents.length} 条最近事件</span>
                </header>
                <div className="runtime-log__list">
                  {runtimeEvents.length ? (
                    runtimeEvents.map((event) => {
                      const expanded = expandedRuntimeEvents.has(event.id);
                      const detail = [
                        event.provider,
                        event.model,
                        event.detail,
                        event.durationMs === undefined ? undefined : `${event.durationMs} ms`,
                      ]
                        .filter(Boolean)
                        .join(" · ");

                      return (
                        <article
                          className={`runtime-log__entry runtime-log__entry--${event.level}${expanded ? " runtime-log__entry--expanded" : ""}`}
                          key={event.id}
                        >
                          <time>{new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</time>
                          <button
                            type="button"
                            className="runtime-log__content"
                            aria-expanded={expanded}
                            title={expanded ? "收起日志详情" : "展开日志详情"}
                            onClick={() => toggleRuntimeEvent(event.id)}
                          >
                            <span className="runtime-log__headline">
                              <strong>{event.message}</strong>
                              <ChevronDown aria-hidden="true" size={14} />
                            </span>
                            <p>{detail}</p>
                          </button>
                        </article>
                      );
                    })
                  ) : (
                    <p className="runtime-log__empty">等待 API 请求。请求、格式转换、上游响应和异常都会显示在这里。</p>
                  )}
                </div>
              </section>
            </section>
          ) : (
            <section className="page">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">CONFIGURATION</p>
                  <h1>配置工作台</h1>
                  <p>管理 Provider、模型、路由与 API 连接参数。</p>
                </div>
                <div className="page-actions">
                  <button className="button button--quiet" onClick={() => void load()}>
                    <RefreshCw size={16} />
                    重新加载
                  </button>
                  <button className="button button--secondary" disabled={busy} onClick={() => void save(false)}>
                    <Save size={16} />
                    保存
                  </button>
                  <button className="button button--primary" disabled={busy} onClick={() => void save(true)}>
                    <RefreshCw size={16} />
                    保存并重启
                  </button>
                </div>
              </div>

              <div className="config-toolbar">
                <div className="protocol-tabs">
                  <button className={protocol === "all" ? "protocol-tabs__active" : ""} onClick={() => setProtocol("all")}>
                    全部
                  </button>
                  <button className={protocol === "openai" ? "protocol-tabs__active" : ""} onClick={() => setProtocol("openai")}>
                    OpenAI
                  </button>
                  <button className={protocol === "anthropic" ? "protocol-tabs__active" : ""} onClick={() => setProtocol("anthropic")}>
                    Anthropic
                  </button>
                </div>
                <button className="button button--primary" onClick={() => openEditor()}>
                  <Plus size={16} />
                  新增模型
                </button>
              </div>

              <div className="model-grid">
                {filtered.map((provider) => {
                  const index = providers.indexOf(provider);
                  return (
                    <article className="model-card" key={`${provider.name}-${index}`}>
                      <div className="model-card__head">
                        <div>
                          <h3>{provider.name}</h3>
                          <p title={modelSummary(provider.models)}>{modelSummary(provider.models) || "未配置模型"}</p>
                        </div>
                        <span className="protocol-badge">{provider.api}</span>
                      </div>
                      <p className="model-card__route">{provider.api_base_url || "未配置接口地址"}</p>
                      <div className="model-card__details">
                        <div>
                          <span>HOST</span>
                          <strong>{hostOf(provider.api_base_url) || "-"}</strong>
                        </div>
                        <div>
                          <span>API KEY</span>
                          <strong>
                            <KeyRound size={12} />
                            {mask(provider.api_key)}
                          </strong>
                        </div>
                      </div>
                      <div className="model-card__actions">
                        <button onClick={() => openEditor(index)}>
                          <Pencil size={14} />
                          编辑
                        </button>
                        <button
                          onClick={() =>
                            updateProviders([...providers, { ...clone(provider), name: `${provider.name} - 副本` }])
                          }
                        >
                          <Copy size={14} />
                          复制
                        </button>
                        <button className="danger-text" onClick={() => remove(index)}>
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>

              {filtered.length === 0 && (
                <div className="empty-models">
                  当前筛选下没有模型配置。
                  <button onClick={() => openEditor()}>新增模型</button>
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {notice && (
        <div className={`toast toast--${notice.tone}`}>
          <Check size={16} />
          {notice.message}
        </div>
      )}

      {draft && (
        <div className="modal-backdrop" onMouseDown={closeEditor}>
          <section className="model-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">MODEL CONFIGURATION</p>
                <h2>{editingIndex === null ? "新增模型" : "编辑模型"}</h2>
              </div>
              <button className="icon-button" onClick={closeEditor}>
                <X size={18} />
              </button>
            </header>

            <div className="modal-form">
              <label>
                配置名称
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label>
                协议
                <select value={draft.api} onChange={(event) => setDraft({ ...draft, api: event.target.value })}>
                  <option>OpenAI</option>
                  <option>Anthropic</option>
                  <option>openai-responses</option>
                </select>
              </label>
              <label className="span-2">
                API Base URL
                <input
                  value={draft.api_base_url}
                  onChange={(event) => setDraft({ ...draft, api_base_url: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="span-2">
                API Key
                <input
                  type="password"
                  value={draft.api_key === "[configured]" ? "" : draft.api_key}
                  placeholder={draft.api_key === "[configured]" ? "已配置，留空则保留" : "sk-..."}
                  onChange={(event) => setDraft({ ...draft, api_key: event.target.value || draft.api_key })}
                />
              </label>

              <section className="model-mappings span-2">
                <div className="model-mappings__head">
                  <div>
                    <strong>模型映射</strong>
                    <p>应用填写 CCR 模型别名，CCR 会将请求转为上游模型名。</p>
                  </div>
                  <button className="button button--secondary" type="button" onClick={() => updateDraftMappings((mappings) => [...mappings, emptyModelMapping()])}>
                    <Plus size={14} />
                    添加模型
                  </button>
                </div>

                {draftMappings.length ? (
                  <div className="model-mappings__list">
                    {draftMappings.map((mapping, index) => (
                      <div className="model-mapping" key={`${index}-${mapping.name}`}>
                        <label>
                          上游模型名
                          <input
                            value={mapping.name}
                            placeholder="gpt-5.6-sol"
                            onChange={(event) =>
                              updateDraftMappings((mappings) =>
                                mappings.map((item, current) =>
                                  current === index ? { ...item, name: event.target.value } : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <label>
                          CCR 模型别名
                          <input
                            value={mapping.aliases.join(", ")}
                            placeholder="gpt-5.6-sol-ymeng-long"
                            onChange={(event) =>
                              updateDraftMappings((mappings) =>
                                mappings.map((item, current) =>
                                  current === index
                                    ? {
                                        ...item,
                                        aliases: parseAliases(event.target.value),
                                        preserveObject: true,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <button
                          className="icon-button model-mapping__remove"
                          type="button"
                          aria-label={`删除模型 ${mapping.name || index + 1}`}
                          onClick={() => updateDraftMappings((mappings) => mappings.filter((_, current) => current !== index))}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="model-mappings__empty">尚未配置模型。添加后请同时填写上游模型名和 CCR 模型别名。</p>
                )}
                {draftError && <p className="model-mappings__error">{draftError}</p>}
              </section>

              <label>
                最大并发
                <input
                  type="number"
                  min="1"
                  value={String(draft.max_concurrency ?? 50)}
                  onChange={(event) => setDraft({ ...draft, max_concurrency: Number(event.target.value) || 50 })}
                />
              </label>
              <label>
                上下文长度
                <input
                  type="number"
                  min="0"
                  value={String(draft.context_length ?? 300000)}
                  onChange={(event) => setDraft({ ...draft, context_length: Number(event.target.value) || 300000 })}
                />
              </label>
            </div>

            <footer>
              <button className="button button--secondary" onClick={closeEditor}>
                取消
              </button>
              <button className="button button--primary" disabled={busy} onClick={() => void commitDraft()}>
                <Save size={16} />
                应用并保存
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);