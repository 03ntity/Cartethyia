import { Check, ChevronDown, Cpu, FileText, FileUp, Globe2, Layers, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Banner } from "./patterns/banner";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { CardActions } from "./ui/inline";
import { Textarea } from "./ui/input";
import { Select } from "./ui/select";
import { Stack } from "./ui/stack";
import { ErrorState, LoadingState } from "./ui/state";
import { Switch } from "./ui/switch";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderModels, useProviders } from "../hooks/providers";
import { useSystemPrompt, useUpdateSystemPrompt } from "../hooks/system-prompt";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import { isWrappedInjectionProvider } from "../../../src/console/system-prompt/contracts";
import type { PromptSetting, TenantSystemPrompts } from "../../../src/console/system-prompt/contracts";
import type { ProviderResponse } from "../data/contracts";

const EMPTY_STATE: TenantSystemPrompts = { global: null, providers: {}, models: {} };

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

const MODE_OPTIONS = [
  { value: "append", label: "Append" },
  { value: "override", label: "Override" },
] as const;

/** Accepted import formats: raw text (.txt) and structured prompt files (.json). */
const IMPORT_ACCEPT = ".txt,.json,text/plain,application/json";

function enabledSetting(text: string, mode: PromptSetting["mode"]): PromptSetting {
  return { enabled: true, mode, text };
}

/** A searchable select (combobox) for option lists that get long. */
function SearchableSelect({
  id,
  label,
  value,
  options,
  placeholder = "Select…",
  onValueChange,
}: {
  readonly id: string;
  readonly label?: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
  readonly placeholder?: string;
  readonly onValueChange: (value: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery === ""
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {label ? (
        <label htmlFor={id} className="form-label mb-3 flex items-center justify-between text-caption font-semibold text-text-primary">
          <span>{label}</span>
        </label>
      ) : null}
      <button
        type="button"
        id={id}
        className="radix-select-trigger inline-flex h-18 w-full items-center justify-between gap-4 rounded-control border border-inner-border bg-surface-2 px-6 text-body font-sans text-text-primary text-left cursor-pointer transition-[border-color,background-color] duration-150 ease-spring hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-1"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute z-toast mt-2 w-full overflow-hidden rounded-card border border-border-strong bg-popover-bg p-2.5 shadow-popout backdrop-blur-xl box-border">
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers…"
            aria-label="Search providers"
            className="form-input mb-2 w-full rounded-control border border-inner-border bg-surface-2 px-5 py-3 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
          />
          <ul role="listbox" className="max-h-112 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-5 py-4 text-badge text-text-tertiary">No matching providers</li>
            ) : (
              filtered.map((option) => (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-control px-5 py-4 text-caption font-medium text-text-primary transition-colors duration-150 select-none hover:bg-surface-hover"
                  onClick={() => {
                    onValueChange(option.value);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value ? (
                    <Check size={14} className="shrink-0 text-accent" />
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Shared editor body for one scope: mode selector, prompt textarea, import. */
function PromptEditor({
  id,
  value,
  onChange,
  rows = 4,
}: {
  readonly id: string;
  readonly value: PromptSetting;
  readonly onChange: (next: PromptSetting) => void;
  readonly rows?: number;
}): ReactNode {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      onChange({ ...value, text, enabled: true });
      setImportError(null);
    } catch {
      setImportError("Could not read that file.");
    }
  };
  return (
    <div className="mt-3">
      <div className="mb-3 flex items-center gap-3">
        <Select
          aria-label="Injection mode"
          value={value.mode}
          onValueChange={(next) => onChange({ ...value, mode: next as PromptSetting["mode"] })}
          options={MODE_OPTIONS}
          size="sm"
        />
        <span className="ml-auto text-badge tabular-nums text-text-tertiary">
          {value.text.length.toLocaleString()} chars · 5 MB cap
        </span>
      </div>
      <Textarea
        id={id}
        rows={rows}
        value={value.text}
        onChange={(event) => onChange({ ...value, text: event.target.value })}
        placeholder="Injected system prompt…"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<FileUp size={13} />}
          onClick={() => fileRef.current?.click()}
        >
          Import .txt/.json
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={IMPORT_ACCEPT}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            void onImport(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {importError ? (
          <p className="text-badge text-red" role="alert">
            {importError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Global scope row: toggle + mode + textarea. */
function GlobalScopeSection({
  value,
  onChange,
}: {
  readonly value: PromptSetting | null;
  readonly onChange: (next: PromptSetting | null) => void;
}): ReactNode {
  const active = value !== null;
  return (
    <div className="rounded-control border border-inner-border bg-surface-2 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="text-body font-semibold">Global injection</p>
            <Badge tone={active && value?.enabled ? "ok" : "default"} dot>
              {active && value?.enabled ? "Active" : "Off"}
            </Badge>
          </div>
          <p className="mt-1 text-badge leading-normal text-text-tertiary">
            Applied to every request regardless of provider or model.
          </p>
        </div>
        <Switch
          id="isp-global"
          checked={active && value?.enabled === true}
          onChange={(next) => onChange(next ? enabledSetting(value?.text ?? "", value?.mode ?? "append") : null)}
          aria-label="Enable global injection"
          className="shrink-0"
        />
      </div>
      {active && value ? <PromptEditor id="isp-global-prompt" value={value} onChange={onChange} /> : null}
    </div>
  );
}

/** One provider card: follow-global toggle, custom setup dialog, wrapped badge. */
function ProviderScopeCard({
  provider,
  entry,
  globalPrompt,
  onChange,
}: {
  readonly provider: ProviderResponse;
  readonly entry: { followGlobal: boolean; setting?: PromptSetting } | undefined;
  readonly globalPrompt: PromptSetting | null;
  readonly onChange: (next: { followGlobal: boolean; setting?: PromptSetting } | undefined) => void;
}): ReactNode {
  const [setupOpen, setSetupOpen] = useState(false);
  const providerLabel = provider.label ?? provider.displayName;
  const followGlobal = entry === undefined || entry.followGlobal;
  const wrapped = isWrappedInjectionProvider(provider.providerId);
  const customSetting = entry?.setting;
  // "Active" = this card's scope actually injects on a request right now:
  // a custom enabled setting, or follow-global with an enabled global. An
  // explicitly-configured but disabled custom setting is "configured" — it
  // shows so the operator knows a saved prompt exists here — but the tint
  // follows the active state, since that is what traffic sees.
  const customConfigured = !followGlobal && customSetting !== undefined;
  const active = customConfigured && customSetting!.enabled === true;
  const followingActiveGlobal = followGlobal && globalPrompt !== null && globalPrompt.enabled;

  return (
    <div
      className={`rounded-control border p-5 ${
        active ? "border-inner-border bg-green-soft/40" : "border-inner-border bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <ProviderIcon icon={provider.providerId} name={provider.displayName} size={28} />
            <div className="min-w-0">
              <p className="truncate text-body font-semibold text-text-primary">{providerLabel}</p>
              <p className="truncate text-badge text-text-tertiary">{provider.providerId}</p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {active ? (
            <Badge tone="ok" dot>
              Active
            </Badge>
          ) : customConfigured ? (
            <Badge tone="warn" dot>
              Custom off
            </Badge>
          ) : followingActiveGlobal ? (
            <Badge tone="info" dot>
              Following global
            </Badge>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            icon={<Settings2 size={13} />}
            onClick={() => setSetupOpen(true)}
          >
            Setup
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        {followGlobal ? (
          <p className="text-badge leading-normal text-text-tertiary">
            {globalPrompt !== null && globalPrompt.enabled
              ? `Following global${globalPrompt.mode === "override" ? " (override)" : ""}.`
              : "Following global — no global prompt configured."}
          </p>
        ) : customSetting?.enabled ? (
          <p className="line-clamp-2 flex-1 whitespace-pre-wrap break-words text-badge leading-normal text-text-secondary">
            {customSetting.text}
          </p>
        ) : (
          <p className="text-badge leading-normal text-text-tertiary">
            Custom — no prompt set yet.
          </p>
        )}
        {wrapped ? (
          <Badge tone="info" title="This provider validates its fixed system prompt; your text is appended after it inside gateway markers.">
            Wrapped
          </Badge>
        ) : null}
      </div>

      <Dialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title={`Setup — ${providerLabel}`}
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setSetupOpen(false)}>
            Close
          </Button>
        }
      >
        <Stack gap="14px">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-body font-semibold">Custom prompt</p>
              <p className="text-badge leading-normal text-text-tertiary">
                {wrapped
                  ? "Your text is appended after this provider's fixed identity prompt, wrapped in gateway markers. Override is not available."
                  : "Replaces or extends the caller's system content for this provider."}
              </p>
            </div>
            <Switch
              id={`isp-provider-${provider.providerId}-custom`}
              checked={!followGlobal}
              onChange={(next) =>
                onChange(
                  next
                    ? { followGlobal: false, setting: customSetting ?? { enabled: true, mode: "append", text: "" } }
                    : undefined,
                )
              }
              aria-label="Use a custom prompt for this provider"
            />
          </div>
          {!followGlobal && customSetting ? (
            <PromptEditor
              id={`isp-provider-${provider.providerId}-prompt`}
              value={customSetting}
              onChange={(next) => onChange({ followGlobal: false, setting: next })}
              rows={6}
            />
          ) : null}
        </Stack>
      </Dialog>
    </div>
  );
}

/** One model card in the per-model grid: model id, active badge, toggle, and
 * the inline prompt editor when enabled.
 */
function ModelScopeRow({
  providerId,
  modelId,
  route,
  value,
  onChange,
}: {
  readonly providerId: string;
  readonly modelId: string;
  readonly route: string;
  readonly value: PromptSetting | undefined;
  readonly onChange: (next: PromptSetting | undefined) => void;
}): ReactNode {
  const active = value !== undefined && value.enabled;
  const key = modelKey(providerId, modelId);
  return (
    <div
      className={`rounded-control border p-4 ${
        active ? "border-inner-border bg-green-soft/40" : "border-inner-border bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption font-semibold text-text-primary">{modelId}</p>
          <p className="truncate text-badge text-text-tertiary">{route}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {active ? (
            <Badge tone="ok" dot>
              Active
            </Badge>
          ) : null}
          <Switch
            id={`isp-model-${key}`}
            checked={active}
            onChange={(next) => onChange(next ? (value ?? enabledSetting("", "append")) : undefined)}
            aria-label={`Enable injection for ${modelId}`}
          />
        </div>
      </div>
      {value !== undefined && value.enabled ? (
        <PromptEditor id={`isp-model-${key}-prompt`} value={value} onChange={onChange} rows={3} />
      ) : null}
    </div>
  );
}

/**
 * The modal for configuring system-prompt injection at three scopes:
 * Global → Per model → Per provider, with provider follow-global toggles and
 * per-scope append/override modes. Persists via `PUT /system-prompt`.
 */
export function InjectSystemPromptDialog({
  open,
  onClose,
  state,
  onSave,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: TenantSystemPrompts;
  readonly onSave: (next: TenantSystemPrompts) => void;
}): ReactNode {
  const [draft, setDraft] = useState<TenantSystemPrompts>(state);
  // Re-sync the draft only on the closed → open transition. `state` is a
  // React Query result whose object identity changes on every background
  // refetch; keying the effect on it would clobber the operator's in-progress
  // edits (and resurrect pre-edit text) mid-session. While open, the draft is
  // the sole source of truth until Save/Cancel closes the dialog.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(state);
    wasOpen.current = open;
  }, [open, state]);

  const providersQuery = useProviders();
  const providerRows = providersQuery.data ?? [];
  const [providerSearch, setProviderSearch] = useState("");
  const query = providerSearch.trim().toLowerCase();
  const filteredProviders =
    query === ""
      ? providerRows
      : providerRows.filter((provider) =>
          `${provider.label ?? provider.displayName} ${provider.providerId}`
            .toLowerCase()
            .includes(query),
        );
  const [modelProviderId, setModelProviderId] = useState("");
  const modelsQuery = useProviderModels(modelProviderId || undefined);
  const modelRows = modelsQuery.data ?? [];

  useEffect(() => {
    if (modelProviderId === "" && providerRows.length > 0) {
      setModelProviderId(providerRows[0]!.providerId);
    }
  }, [providerRows, modelProviderId]);

  const patchGlobal = (next: PromptSetting | null) =>
    setDraft((prev) => ({ ...prev, global: next }));
  const patchProvider = (
    providerId: string,
    next: { followGlobal: boolean; setting?: PromptSetting } | undefined,
  ) =>
    setDraft((prev) => {
      const providers = { ...prev.providers };
      if (next === undefined) delete providers[providerId];
      else providers[providerId] = next;
      return { ...prev, providers };
    });
  const patchModel = (providerId: string, modelId: string, next: PromptSetting | undefined) =>
    setDraft((prev) => {
      const models = { ...prev.models };
      const key = modelKey(providerId, modelId);
      if (next === undefined) delete models[key];
      else models[key] = next;
      return { ...prev, models };
    });

  const providerOptions = providerRows.map((provider) => ({
    value: provider.providerId,
    label: provider.label ?? provider.displayName,
  }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Inject System Prompt"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <Stack gap="20px">
        <section>
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Globe2 size={14} className="text-text-secondary" aria-hidden="true" />
            Global
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Applied to every request regardless of provider or model.
          </p>
          <GlobalScopeSection value={draft.global} onChange={patchGlobal} />
        </section>

        <section className="border-t border-inner-border pt-6">
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Cpu size={14} className="text-text-secondary" aria-hidden="true" />
            Per model
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Only that exact model of a provider gets this prompt; it wins over the provider and
            global injections.
          </p>
          <SearchableSelect
            label="Provider"
            id="isp-model-provider"
            value={modelProviderId}
            onValueChange={setModelProviderId}
            options={providerOptions}
            placeholder="Select provider…"
          />
          <div className="mt-3">
            {modelProviderId === "" ? (
              <p className="text-badge leading-normal text-text-tertiary">
                Select a provider to configure per-model injections.
              </p>
            ) : modelsQuery.isPending ? (
              <LoadingState label="Loading models…" />
            ) : modelsQuery.isError ? (
              <ErrorState message="Failed to load models" onRetry={() => void modelsQuery.refetch()} />
            ) : modelRows.length === 0 ? (
              <p className="text-badge leading-normal text-text-tertiary">
                No models configured for this provider.
              </p>
            ) : (
              <>
                {(() => {
                  const activeModels = modelRows.filter(
                    (model) => draft.models[modelKey(modelProviderId, model.modelId)]?.enabled,
                  ).length;
                  return (
                    <p className="mb-3 text-badge leading-normal text-text-tertiary">
                      {activeModels > 0
                        ? `${activeModels} of ${modelRows.length} models active for this provider.`
                        : `${modelRows.length} models — none active yet.`}
                    </p>
                  );
                })()}
                <div className="grid grid-cols-3 gap-4 max-medium:grid-cols-2 max-small:grid-cols-1">
                  {modelRows.map((model) => (
                    <ModelScopeRow
                      key={modelKey(modelProviderId, model.modelId)}
                      providerId={modelProviderId}
                      modelId={model.modelId}
                      route={model.route}
                      value={draft.models[modelKey(modelProviderId, model.modelId)]}
                      onChange={(next) => patchModel(modelProviderId, model.modelId, next)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        <section className="border-t border-inner-border pt-6">
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Layers size={14} className="text-text-secondary" aria-hidden="true" />
            Per provider
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Follow the global prompt, or carry a custom one — models under a custom provider can
            still override per-model.
          </p>
          {providersQuery.isPending ? (
            <LoadingState label="Loading providers…" />
          ) : providersQuery.isError ? (
            <ErrorState message="Failed to load providers" onRetry={() => void providersQuery.refetch()} />
          ) : providerRows.length === 0 ? (
            <p className="text-badge leading-normal text-text-tertiary">No providers configured yet.</p>
          ) : (
            <>
              <input
                type="search"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                placeholder="Search providers…"
                aria-label="Search providers"
                className="form-input w-full rounded-control border border-inner-border bg-surface-2 px-6 py-4 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
              />
              {filteredProviders.length === 0 ? (
                <p className="mt-4 text-badge leading-normal text-text-tertiary">
                  No providers match “{providerSearch.trim()}”.
                </p>
              ) : (
                <div className="mt-4 grid grid-cols-3 gap-4 max-medium:grid-cols-2 max-small:grid-cols-1">
                  {filteredProviders.map((provider) => (
                    <ProviderScopeCard
                      key={provider.providerId}
                      provider={provider}
                      entry={draft.providers[provider.providerId]}
                      globalPrompt={draft.global}
                      onChange={(next) => patchProvider(provider.providerId, next)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </Stack>
    </Dialog>
  );
}

/**
 * The Overview card for system-prompt injection: status tiles for the three
 * scopes and an "Open Settings" button launching the dialog. State persists
 * through `PUT /system-prompt`.
 */
export function InjectSystemPromptPanel(): ReactNode {
  const [open, setOpen] = useState(false);
  const settingsQuery = useSystemPrompt();
  const update = useUpdateSystemPrompt();
  const state = settingsQuery.data ?? EMPTY_STATE;

  const providerCount = Object.values(state.providers).filter(
    (entry) => !entry.followGlobal && entry.setting?.enabled,
  ).length;
  const modelCount = Object.values(state.models).filter((setting) => setting.enabled).length;

  return (
    <Card>
      <CardHeader
        title="Inject System Prompt"
        subtitle="Append custom system instructions to requests"
        icon={<FileText size={16} />}
        action={
          <CardActions>
            <Button
              variant="secondary"
              size="sm"
              icon={<Settings2 size={13} />}
              onClick={() => setOpen(true)}
            >
              Open Settings
            </Button>
          </CardActions>
        }
      />
      <CardBody>
        <Stack gap="14px">
          <div className="grid grid-cols-3 gap-4 max-medium:grid-cols-1">
            {(() => {
              const globalOn = state.global !== null && state.global.enabled;
              const Tile = ({
                icon,
                label,
                value,
                active,
              }: {
                readonly icon: ReactNode;
                readonly label: string;
                readonly value: string;
                readonly active: boolean;
              }) => (
                <div
                  className={`flex items-center gap-3 rounded-control border px-4 py-3.5 ${
                    active ? "border-inner-border bg-green-soft" : "border-inner-border bg-surface-2"
                  }`}
                >
                  <span
                    className={`shrink-0 ${active ? "text-green" : "text-text-tertiary"}`}
                    aria-hidden="true"
                  >
                    {icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-badge text-text-tertiary">{label}</p>
                    <p
                      className={`truncate text-body font-semibold ${
                        active ? "text-green" : "text-text-tertiary"
                      }`}
                    >
                      {value}
                    </p>
                  </div>
                </div>
              );
              return (
                <>
                  <Tile
                    icon={<Globe2 size={16} />}
                    label="Global"
                    value={globalOn ? state.global?.mode === "override" ? "Override" : "On" : "Off"}
                    active={globalOn}
                  />
                  <Tile
                    icon={<Layers size={16} />}
                    label="Providers"
                    value={providerCount > 0 ? `${providerCount} custom` : "Follow global"}
                    active={providerCount > 0}
                  />
                  <Tile
                    icon={<Cpu size={16} />}
                    label="Models"
                    value={modelCount > 0 ? `${modelCount} active` : "None"}
                    active={modelCount > 0}
                  />
                </>
              );
            })()}
          </div>
          {settingsQuery.isError ? (
            <Banner tone="danger" surface="raised" live="status">
              {getErrorMessage(settingsQuery.error, "Failed to load system prompt settings")}
            </Banner>
          ) : null}
          <p className="text-caption leading-normal text-text-secondary">
            Add custom system prompts at three levels — global, per provider, or per model —
            handy for enforcing tone, rules, or context where you need it.
          </p>
        </Stack>
      </CardBody>
      <InjectSystemPromptDialog
        open={open}
        onClose={() => setOpen(false)}
        state={state}
        onSave={(next) =>
          update.mutate(next, {
            onSuccess: () => toast.success("System prompt settings saved"),
            onError: (error) => toast.error(getErrorMessage(error, "Could not save system prompt settings")),
          })
        }
      />
    </Card>
  );
}
