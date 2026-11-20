import type {
  BrokerAccountContext,
  BrokerAdapter,
  BrokerAssetClass,
  BrokerAssetInfo,
  BrokerCandle,
  BrokerCapabilities,
  BrokerConnectorDiagnostics,
  BrokerOrderPlacementResult,
  BrokerOrderReconciliationResult,
  BrokerOrderRequest,
  BrokerOrderType,
  BrokerOrderValidationResult,
  BrokerPosition,
  BrokerQuote,
  BrokerStatusSnapshot,
  BrokerTradeHistoryResult,
  InstrumentCompatibilityResult,
} from './types.ts';

const IQ_LIMITATIONS = [
  'IQ Option does not provide an officially documented public retail trading API; NovaTrade uses your self-hosted iq-connector.',
  'Account mode (PRACTICE or REAL) automatically follows whichever mode is currently active inside IQ Option.',
  'Accounts requiring 2FA, captcha verification, or restricted by jurisdiction cannot authenticate automatically.',
  'Every trade verifies the active IQ Option account mode directly from the broker before execution.',
];

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export type VerifiedIqAccountMode = 'PRACTICE' | 'REAL' | 'UNVERIFIED';

export function parseVerifiedIqMode(rawMode: unknown, modeVerified?: boolean): VerifiedIqAccountMode {
  if (modeVerified === false) return 'UNVERIFIED';
  const normalized = String(rawMode || '').trim().toUpperCase();
  if (normalized === 'PRACTICE') return 'PRACTICE';
  if (normalized === 'REAL') return 'REAL';
  return 'UNVERIFIED';
}

export interface ParsedIqConnectorConfig {
  configured: boolean;
  url: string | null;
  urlValid: boolean;
  hadVarNamePrefix: boolean;
  isLocalhost: boolean;
  targetHost: string | null;
  tokenConfigured: boolean;
  warnings: string[];
}

export function parseIqConnectorConfig(
  rawInput = process.env.IQ_CONNECTOR_URL || '',
  tokenInput = process.env.IQ_CONNECTOR_TOKEN || ''
): ParsedIqConnectorConfig {
  let raw = rawInput.trim();
  const tokenConfigured = Boolean(tokenInput.trim());
  if (!raw) {
    return {
      configured: false,
      url: null,
      urlValid: false,
      hadVarNamePrefix: false,
      isLocalhost: false,
      targetHost: null,
      tokenConfigured,
      warnings: [],
    };
  }

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }

  const warnings: string[] = [];
  let hadVarNamePrefix = false;
  if (/^IQ_CONNECTOR_URL\s*=/i.test(raw)) {
    hadVarNamePrefix = true;
    raw = raw.replace(/^IQ_CONNECTOR_URL\s*=\s*/i, '').trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
    }
    warnings.push(
      'IQ_CONNECTOR_URL contained the "IQ_CONNECTOR_URL=" variable name prefix. Store only the URL value (e.g. https://your-connector.example).'
    );
  }

  if (!raw) {
    return {
      configured: true,
      url: null,
      urlValid: false,
      hadVarNamePrefix,
      isLocalhost: false,
      targetHost: null,
      tokenConfigured,
      warnings: [...warnings, 'IQ_CONNECTOR_URL is empty after stripping the variable name prefix.'],
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        configured: true,
        url: null,
        urlValid: false,
        hadVarNamePrefix,
        isLocalhost: false,
        targetHost: null,
        tokenConfigured,
        warnings: [...warnings, 'IQ_CONNECTOR_URL must use http:// or https:// protocol.'],
      };
    }

    const host = parsed.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (isLocalhost) {
      warnings.push(
        `IQ_CONNECTOR_URL points to ${parsed.hostname}, which refers to this container itself. Deploy novatrade-ai/iq-connector separately and set its public HTTPS URL.`
      );
    }

    const normalized = raw.replace(/\/+$/, '');
    return {
      configured: true,
      url: normalized,
      urlValid: true,
      hadVarNamePrefix,
      isLocalhost,
      targetHost: parsed.host,
      tokenConfigured,
      warnings,
    };
  } catch {
    return {
      configured: true,
      url: null,
      urlValid: false,
      hadVarNamePrefix,
      isLocalhost: false,
      targetHost: null,
      tokenConfigured,
      warnings: [...warnings, 'IQ_CONNECTOR_URL is not a valid URL. Provide only the http(s) base URL.'],
    };
  }
}

export class IQOptionAdapter implements BrokerAdapter {
  readonly brokerId = 'iq_option' as const;
  readonly brokerName = 'IQ Option';

  private readonly inflightConnect = new Map<
    string,
    Promise<{
      connected: boolean;
      accountType: string | null;
      balance: number | null;
      equity: number | null;
      currency: string | null;
      externalAccountId: string | null;
      message: string;
    }>
  >();

  private readonly inflightStatus = new Map<string, Promise<BrokerStatusSnapshot>>();

  private readonly inflightWake = new Map<string, Promise<void>>();

  private readonly lastReachableAt = new Map<string, number>();

  private getConfig(ctx?: BrokerAccountContext): ParsedIqConnectorConfig {
    const url = ctx?.credentials.bridgeUrl || process.env.IQ_CONNECTOR_URL || '';
    const token = ctx?.credentials.bridgeToken || process.env.IQ_CONNECTOR_TOKEN || '';
    return parseIqConnectorConfig(url, token);
  }

  private getHeaders(ctx?: BrokerAccountContext): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-iq-mode': 'AUTO',
    };
    const token = (ctx?.credentials.bridgeToken || process.env.IQ_CONNECTOR_TOKEN || '').trim();
    if (token) headers['x-connector-token'] = token;
    return headers;
  }

  private getWakeTiming(): { budgetMs: number; baseBackoffMs: number; healthTimeoutMs: number; maxHealthAttempts: number } {
    const envBudget = Number(process.env.IQ_CONNECTOR_WAKE_BUDGET_MS);
    const envBackoff = Number(process.env.IQ_CONNECTOR_WAKE_BACKOFF_MS);
    const envHealthTimeout = Number(process.env.IQ_CONNECTOR_HEALTH_TIMEOUT_MS);
    const budgetMs = Number.isFinite(envBudget) && envBudget >= 500 && envBudget <= 90000 ? envBudget : 60000;
    const baseBackoffMs = Number.isFinite(envBackoff) && envBackoff >= 20 && envBackoff <= 10000 ? envBackoff : 1500;
    const healthTimeoutMs =
      Number.isFinite(envHealthTimeout) && envHealthTimeout >= 500 && envHealthTimeout <= 45000 ? envHealthTimeout : 20000;
    return { budgetMs, baseBackoffMs, healthTimeoutMs, maxHealthAttempts: 20 };
  }

  private async ensureConnectorAwake(ctx?: BrokerAccountContext, force = false): Promise<void> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured || !cfg.urlValid || !cfg.url) {
      return;
    }
    const lastSeen = this.lastReachableAt.get(cfg.url) || 0;
    if (!force && lastSeen > 0 && Date.now() - lastSeen < 60_000) {
      return;
    }
    const existing = this.inflightWake.get(cfg.url);
    if (existing) {
      return existing;
    }
    const wakePromise = this.requestConnector<Record<string, unknown>>('/health', {}, ctx)
      .then(() => undefined)
      .finally(() => {
        if (this.inflightWake.get(cfg.url!) === wakePromise) {
          this.inflightWake.delete(cfg.url!);
        }
      });
    this.inflightWake.set(cfg.url, wakePromise);
    return wakePromise;
  }

  private async requestConnector<T>(path: string, init: RequestInit = {}, ctx?: BrokerAccountContext): Promise<T> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured) {
      throw new Error('IQ_CONNECTOR_URL is not configured.');
    }
    if (!cfg.urlValid || !cfg.url) {
      throw new Error(cfg.warnings[0] || 'IQ_CONNECTOR_URL is invalid.');
    }

    const isHealth = path === '/health';
    const isConnect = path === '/connect';
    const isOrder = path === '/order';
    const wake = this.getWakeTiming();
    const maxAttempts = isHealth ? wake.maxHealthAttempts : isOrder ? 1 : 2;
    // Align /health timeout (20s) above Render Free-tier cold-start spin-up (~14s measured)
    // and /connect timeout (28s) above the connector's bounded connect+mode budget (~23s)
    // so Node does not abort while the connector is waking or finishing the broker handshake.
    const timeoutMs = isHealth ? wake.healthTimeoutMs : isConnect ? 28000 : 18000;
    const baseBackoffMs = isHealth ? wake.baseBackoffMs : isConnect ? 2000 : 1200;
    const startedAt = Date.now();
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const elapsedMs = Date.now() - startedAt;
      const attemptTimeoutMs = isHealth
        ? Math.max(1000, Math.min(timeoutMs, wake.budgetMs - elapsedMs))
        : timeoutMs;
      try {
        const res = await fetch(`${cfg.url}${path}`, {
          ...init,
          headers: { ...this.getHeaders(ctx), ...(init.headers || {}) },
          signal: AbortSignal.timeout(attemptTimeoutMs),
        });

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const text = await res.text();
        const trimmed = text.trimStart();
        const looksHtml =
          contentType.includes('text/html') ||
          (trimmed.startsWith('<') && /^(<!doctype\s+html|<html|<head|<body|<title|<h1)/i.test(trimmed));

        if (looksHtml) {
          if (res.status === 502 || res.status === 503 || res.status === 504) {
            this.lastReachableAt.delete(cfg.url);
            const remainingBudgetMs = isHealth ? wake.budgetMs - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;
            const sleepMs = Math.min(4000, baseBackoffMs * attempt);
            if (attempt < maxAttempts && (!isHealth || remainingBudgetMs > 250)) {
              await new Promise((r) => setTimeout(r, isHealth ? Math.min(sleepMs, remainingBudgetMs) : sleepMs));
              continue;
            }
            const waitedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            const htmlErr = new Error(
              `IQ Option connector gateway returned HTTP ${res.status} HTML after ${waitedSec}s (service cold start or upstream timeout).`
            ) as Error & { status?: number; nonRetryable?: boolean; isGatewayColdStart?: boolean };
            htmlErr.status = res.status;
            htmlErr.nonRetryable = true;
            htmlErr.isGatewayColdStart = true;
            throw htmlErr;
          }
          const htmlErr = new Error(`IQ Option connector returned an unexpected HTML response (HTTP ${res.status}).`) as Error & {
            status?: number;
            nonRetryable?: boolean;
          };
          htmlErr.status = res.status;
          htmlErr.nonRetryable = true;
          throw htmlErr;
        }

        let json: Record<string, unknown> = {};
        if (trimmed) {
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
              json = parsed as Record<string, unknown>;
            }
          } catch {
            if (!res.ok) {
              if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
                this.lastReachableAt.delete(cfg.url);
                const remainingBudgetMs = isHealth ? wake.budgetMs - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;
                const sleepMs = Math.min(4000, baseBackoffMs * attempt);
                if (!isHealth || remainingBudgetMs > 250) {
                  await new Promise((r) => setTimeout(r, isHealth ? Math.min(sleepMs, remainingBudgetMs) : sleepMs));
                  continue;
                }
              }
              const parseErr = new Error(`IQ Option connector HTTP ${res.status}.`) as Error & {
                status?: number;
                nonRetryable?: boolean;
                isGatewayColdStart?: boolean;
              };
              parseErr.status = res.status;
              parseErr.nonRetryable = true;
              if (res.status === 502 || res.status === 503 || res.status === 504) {
                parseErr.isGatewayColdStart = true;
              }
              throw parseErr;
            }
            throw new Error('IQ Option connector returned a non-JSON response.');
          }
        }
        // Valid JSON from the connector confirms uvicorn is awake and serving requests
        if (res.status !== 502 && res.status !== 503 && res.status !== 504) {
          this.lastReachableAt.set(cfg.url, Date.now());
        }
        if (!res.ok) {
          const msg = String(json.detail || json.error || `Connector HTTP ${res.status}`);
          // Retry on transient 502/503 (e.g. cold start or momentary busy lock), but do not blindly retry 504 on /connect or /order
          const retryableStatus =
            isConnect || isOrder
              ? res.status === 502 || res.status === 503
              : res.status === 502 || res.status === 503 || res.status === 504;
          if (retryableStatus && attempt < maxAttempts) {
            const remainingBudgetMs = isHealth ? wake.budgetMs - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;
            const sleepMs = Math.min(4000, baseBackoffMs * attempt);
            if (!isHealth || remainingBudgetMs > 250) {
              await new Promise((r) => setTimeout(r, isHealth ? Math.min(sleepMs, remainingBudgetMs) : sleepMs));
              continue;
            }
          }
          const httpErr = new Error(msg) as Error & { status?: number; nonRetryable?: boolean };
          httpErr.status = res.status;
          httpErr.nonRetryable = true;
          throw httpErr;
        }
        return json as T;
      } catch (err) {
        lastErr = err;
        const tagged = err as Error & { nonRetryable?: boolean; name?: string };
        if (tagged?.nonRetryable) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isClientTimeout =
          tagged?.name === 'TimeoutError' ||
          tagged?.name === 'AbortError' ||
          /aborted due to timeout|operation was aborted/i.test(msg);
        if ((isConnect || isOrder) && isClientTimeout) {
          throw new Error(
            `IQ Option connector timed out during ${path} after ${Math.round(timeoutMs / 1000)}s (broker handshake did not complete in time).`
          );
        }
        const isTransient = /timeout|timed out|abort|econnreset|etimedout|econnrefused|fetch failed|gateway returned http 50[234]|502|503|504/i.test(msg);
        if (!isTransient) {
          throw err;
        }
        this.lastReachableAt.delete(cfg.url);
        const remainingBudgetMs = isHealth ? wake.budgetMs - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;
        const sleepMs = Math.min(4000, baseBackoffMs * attempt);
        if (attempt < maxAttempts && (!isHealth || remainingBudgetMs > 250)) {
          await new Promise((r) => setTimeout(r, isHealth ? Math.min(sleepMs, remainingBudgetMs) : sleepMs));
          continue;
        }
        break;
      }
    }

    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`IQ connector unreachable or timed out after ${maxAttempts} attempts (${errMsg}).`);
  }

  async getCapabilities(ctx?: BrokerAccountContext): Promise<BrokerCapabilities> {
    const cfg = this.getConfig(ctx);
    return {
      brokerId: this.brokerId,
      broker: this.brokerName,
      apiType: 'unofficial_connector',
      isOfficialApi: false,
      isPreparedAdapterOnly: !cfg.urlValid,
      adapterInstalled: cfg.urlValid,
      authorisedApiVerified: false,
      connectorConfigured: cfg.urlValid,
      demoSupported: cfg.urlValid,
      realAccountSupported: cfg.urlValid,
      orderExecutionSupported: cfg.urlValid,
      marketDataSupported: cfg.urlValid,
      accountSyncSupported: cfg.urlValid,
      positionsSyncSupported: cfg.urlValid,
      historySupported: cfg.urlValid,
      demoOrderPlacementSupported: cfg.urlValid,
      liveOrderPlacementSupported: cfg.urlValid,
      supportedAssetClasses: ['FOREX', 'CRYPTO', 'BINARY'],
      supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
      environment: cfg.urlValid ? (ctx?.environment === 'real' ? 'real' : 'demo') : null,
      message: !cfg.configured
        ? 'IQ_CONNECTOR_URL is not set. Configure your iq-connector instance to connect IQ Option.'
        : !cfg.urlValid
          ? cfg.warnings[0] || 'IQ_CONNECTOR_URL is malformed.'
          : `IQ Option connector active (${cfg.targetHost}). Automatically follows whichever account mode (PRACTICE or REAL) you select inside IQ Option.`,
      credentialFields: [
        {
          key: 'email',
          label: 'Email',
          secret: false,
          required: true,
          placeholder: 'your-email@example.com',
        },
        {
          key: 'apiSecret',
          label: 'Password',
          secret: true,
          required: true,
          placeholder: 'IQ Option password',
        },
      ],
    };
  }

  async getStatus(ctx?: BrokerAccountContext): Promise<BrokerStatusSnapshot> {
    const cfg = this.getConfig(ctx);
    const key = `${cfg.url || 'unconfigured'}:AUTO`;
    const existing = this.inflightStatus.get(key);
    if (existing) return existing;

    const promise = this.getStatusInternal(ctx).finally(() => {
      if (this.inflightStatus.get(key) === promise) {
        this.inflightStatus.delete(key);
      }
    });
    this.inflightStatus.set(key, promise);
    return promise;
  }

  private async getStatusInternal(ctx?: BrokerAccountContext): Promise<BrokerStatusSnapshot> {
    const caps = await this.getCapabilities(ctx);
    const cfg = this.getConfig(ctx);
    const checkedAt = new Date().toISOString();

    const baseDiagnostics: BrokerConnectorDiagnostics = {
      configured: cfg.configured,
      urlValid: cfg.urlValid,
      hadVarNamePrefix: cfg.hadVarNamePrefix,
      isLocalhost: cfg.isLocalhost,
      reachable: false,
      authenticated: false,
      credentialsConfigured: null,
      tokenConfigured: cfg.tokenConfigured,
      latencyMs: null,
      targetHost: cfg.targetHost,
      warnings: [...cfg.warnings],
      lastConnectorError: null,
    };

    if (!cfg.configured || !cfg.urlValid || !cfg.url) {
      return {
        ...caps,
        connected: false,
        executionEnabled: false,
        accountType: null,
        balance: null,
        equity: null,
        currency: null,
        connectorUrlConfigured: cfg.configured,
        lastCheckedAt: checkedAt,
        limitations: IQ_LIMITATIONS,
        diagnostics: baseDiagnostics,
      };
    }

    const started = Date.now();
    try {
      const health = await this.requestConnector<{
        connected?: boolean;
        authenticated?: boolean;
        busy?: boolean;
        connectInFlight?: boolean;
        mode?: string | null;
        activeMode?: string | null;
        accountType?: string | null;
        modeVerified?: boolean;
        brokerWalletConfirmed?: boolean;
        orderExecutionSupported?: boolean;
        credentialsConfigured?: boolean;
        lastError?: string | null;
      }>('/health', {}, ctx);
      const latencyMs = Date.now() - started;

      const healthAuthenticated = Boolean(health.authenticated ?? health.connected);
      const healthParsedMode = parseVerifiedIqMode(
        health.activeMode || health.accountType || health.mode,
        health.modeVerified
      );
      const isAuthenticatedUnverified =
        healthAuthenticated && (health.modeVerified === false || healthParsedMode === 'UNVERIFIED');

      let balance: number | null = null;
      let accountType: string | null = isAuthenticatedUnverified
        ? 'UNVERIFIED'
        : health.connected && healthParsedMode !== 'UNVERIFIED'
          ? healthParsedMode
          : null;
      let currency: string | null = null;
      let accountSyncError: string | null = isAuthenticatedUnverified
        ? health.lastError || 'IQ Option active account mode is UNVERIFIED; live orders are blocked.'
        : null;
      let modeConfirmed = Boolean(health.connected) && healthAuthenticated && !isAuthenticatedUnverified;

      if (modeConfirmed && !health.connectInFlight) {
        try {
          const acct = await this.requestConnector<{
            accountType?: string;
            activeMode?: string;
            mode?: string;
            modeVerified?: boolean;
            balance?: number;
            currency?: string;
          }>('/account', {}, ctx);
          const reportedMode = parseVerifiedIqMode(
            acct.activeMode || acct.accountType || acct.mode,
            acct.modeVerified
          );
          if (reportedMode === 'UNVERIFIED') {
            accountType = 'UNVERIFIED';
            modeConfirmed = false;
            balance = null;
            accountSyncError = 'IQ Option active account mode is UNVERIFIED; live orders are blocked.';
          } else {
            accountType = reportedMode;
            balance = toFiniteNumber(acct.balance);
            currency = acct.currency || 'USD';
            if (balance === null) {
              accountSyncError = 'IQ Option connector did not return a valid numeric balance.';
            }
          }
        } catch (acctErr) {
          const errMsg = acctErr instanceof Error ? acctErr.message : 'Temporary balance sync timeout.';
          if (/unverified|could not verify active account mode/i.test(errMsg)) {
            accountType = 'UNVERIFIED';
            modeConfirmed = false;
          }
          // A transient /account timeout must NOT mark a healthy verified session disconnected
          accountSyncError = errMsg;
          balance = null;
        }
      }

      const verifiedConnected = modeConfirmed && (accountType === 'PRACTICE' || accountType === 'REAL');
      const detectedEnv: 'real' | 'demo' = verifiedConnected && accountType === 'REAL' ? 'real' : 'demo';
      const diagnostics: BrokerConnectorDiagnostics = {
        ...baseDiagnostics,
        reachable: true,
        authenticated: healthAuthenticated,
        credentialsConfigured:
          typeof health.credentialsConfigured === 'boolean' ? health.credentialsConfigured : null,
        latencyMs,
        lastConnectorError: accountSyncError || (verifiedConnected ? null : health.lastError || null),
      };

      const warningSuffix = cfg.warnings.length > 0 ? ` (${cfg.warnings[0]})` : '';
      return {
        ...caps,
        environment: detectedEnv,
        connected: verifiedConnected,
        executionEnabled: verifiedConnected && health.orderExecutionSupported !== false,
        accountType,
        balance,
        equity: balance,
        currency,
        connectorUrlConfigured: true,
        lastCheckedAt: checkedAt,
        message: verifiedConnected
          ? accountSyncError
            ? `Connected to IQ Option (${accountType}, ${latencyMs}ms) — live balance sync delayed (${accountSyncError}).${warningSuffix}`
            : accountType === 'PRACTICE' && health.brokerWalletConfirmed === false
              ? `Connected to IQ Option (PRACTICE safe fallback — broker did not specify active wallet; real-money orders blocked, ${latencyMs}ms).${warningSuffix}`
              : `Connected to IQ Option (${accountType} mode detected directly from IQ Option, ${latencyMs}ms).${warningSuffix}`
          : accountType === 'UNVERIFIED'
            ? `IQ Option session authenticated (${latencyMs}ms), but active account mode is UNVERIFIED — live orders are blocked until broker mode is confirmed.${warningSuffix}`
            : health.connectInFlight
              ? `IQ connector reachable (${latencyMs}ms); establishing broker session, please wait...${warningSuffix}`
              : health.credentialsConfigured
                ? `IQ connector reachable (${latencyMs}ms); not authenticated (${health.lastError || 'click Connect to initiate session'}).${warningSuffix}`
                : `IQ connector reachable (${latencyMs}ms); sign in with your IQ Option email & password to connect.${warningSuffix}`,
        limitations: IQ_LIMITATIONS,
        diagnostics,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'connection failed';
      const diagnostics: BrokerConnectorDiagnostics = {
        ...baseDiagnostics,
        reachable: false,
        latencyMs: Date.now() - started,
        lastConnectorError: errMsg,
      };
      const warningHint = cfg.warnings.length > 0 ? ` ${cfg.warnings.join(' ')}` : '';
      return {
        ...caps,
        connected: false,
        executionEnabled: false,
        accountType: null,
        balance: null,
        equity: null,
        currency: null,
        connectorUrlConfigured: true,
        lastCheckedAt: checkedAt,
        message: `IQ connector unreachable (${errMsg}).${warningHint}`,
        limitations: IQ_LIMITATIONS,
        diagnostics,
      };
    }
  }

  async connect(ctx?: BrokerAccountContext) {
    const cfg = this.getConfig(ctx);
    const key = `${cfg.url || 'unconfigured'}:${(ctx?.credentials.email || 'env').trim().toLowerCase()}`;
    const existing = this.inflightConnect.get(key);
    if (existing) return existing;

    const promise = this.connectInternal(ctx).finally(() => {
      if (this.inflightConnect.get(key) === promise) {
        this.inflightConnect.delete(key);
      }
    });
    this.inflightConnect.set(key, promise);
    return promise;
  }

  private async connectInternal(ctx?: BrokerAccountContext) {
    const creds = ctx?.credentials || {};
    // Ensure sleeping Render connector is awake before transmitting POST /connect
    // so Render's edge proxy does not drop /connect with HTTP 502 HTML during cold start.
    await this.ensureConnectorAwake(ctx);

    type ConnectPayload = {
      authenticated?: boolean;
      connected?: boolean;
      accountType?: string | null;
      activeMode?: string | null;
      mode?: string | null;
      modeVerified?: boolean;
      brokerWalletConfirmed?: boolean;
      detail?: string | null;
    };

    const sendConnect = () =>
      this.requestConnector<ConnectPayload>(
        '/connect',
        {
          method: 'POST',
          body: JSON.stringify({
            email: creds.email || undefined,
            password: creds.apiSecret || undefined,
          }),
        },
        ctx
      );

    let res: ConnectPayload;
    try {
      res = await sendConnect();
    } catch (err) {
      const tagged = err as Error & { isGatewayColdStart?: boolean };
      if (!tagged?.isGatewayColdStart) {
        throw err;
      }
      // Edge returned 502/503/504 HTML before uvicorn received POST /connect — wake via /health and retry once
      await this.ensureConnectorAwake(ctx, true);
      res = await sendConnect();
    }

    const reportedMode = parseVerifiedIqMode(res.activeMode || res.accountType || res.mode, res.modeVerified);
    let balance: number | null = null;
    let currency: string | null = 'USD';
    let confirmedAccountType: VerifiedIqAccountMode = reportedMode;
    let balanceWarning: string | null = null;

    if (!res.connected || reportedMode === 'UNVERIFIED') {
      const isUnverifiedSession = Boolean(res.authenticated) || String(res.mode || res.accountType || '').toUpperCase() === 'UNVERIFIED';
      return {
        connected: false,
        accountType: isUnverifiedSession ? 'UNVERIFIED' : null,
        balance: null,
        equity: null,
        currency: null,
        externalAccountId: null,
        message:
          res.detail ||
          (isUnverifiedSession
            ? 'IQ Option active account mode could not be verified (UNVERIFIED); live orders are blocked.'
            : 'IQ Option connector did not confirm an active session.'),
      };
    }

    try {
      const acct = await this.getBalance(ctx, true);
      balance = toFiniteNumber(acct.balance);
      currency = acct.currency;
      if (acct.accountType === 'REAL' || acct.accountType === 'PRACTICE') {
        confirmedAccountType = acct.accountType;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Balance unavailable from broker.';
      if (/unverified|could not verify active account mode/i.test(errMsg)) {
        return {
          connected: false,
          accountType: 'UNVERIFIED',
          balance: null,
          equity: null,
          currency: null,
          externalAccountId: null,
          message: errMsg,
        };
      }
      balance = null;
      balanceWarning = errMsg;
    }

    return {
      connected: true,
      accountType: confirmedAccountType,
      balance,
      equity: balance,
      currency,
      externalAccountId: confirmedAccountType === 'REAL' ? 'iq-real' : 'iq-practice',
      message: balanceWarning
        ? `Authenticated with IQ Option in ${confirmedAccountType} mode (detected from IQ Option), but balance sync was delayed (${balanceWarning}).`
        : confirmedAccountType === 'PRACTICE' && res.brokerWalletConfirmed === false
          ? 'Authenticated with IQ Option in PRACTICE safe fallback (broker did not report active wallet; real-money orders remain blocked).'
          : `Authenticated with IQ Option in ${confirmedAccountType} mode (automatically synced from IQ Option).`,
    };
  }

  async disconnect(ctx?: BrokerAccountContext): Promise<{ connected: boolean; message: string }> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured || !cfg.urlValid) {
      return { connected: false, message: 'No valid IQ Option connector configured.' };
    }
    await this.requestConnector('/disconnect', { method: 'POST' }, ctx).catch(() => undefined);
    return { connected: false, message: 'Disconnected from IQ Option connector.' };
  }

  async getBalance(ctx?: BrokerAccountContext, fresh = false) {
    const path = fresh ? '/account?fresh=true' : '/account';
    const acct = await this.requestConnector<{
      balance?: number;
      accountType?: string;
      activeMode?: string;
      mode?: string;
      modeVerified?: boolean;
      currency?: string;
      source?: string;
    }>(path, {}, ctx);
    const verifiedMode = parseVerifiedIqMode(acct.activeMode || acct.accountType || acct.mode, acct.modeVerified);
    if (verifiedMode === 'UNVERIFIED') {
      throw new Error('IQ Option active account mode is UNVERIFIED; live orders and balance sync are blocked.');
    }
    const bal = toFiniteNumber(acct.balance);
    if (bal === null) {
      throw new Error('IQ Option connector returned a missing or non-numeric account balance.');
    }
    return {
      balance: bal,
      equity: bal,
      accountType: verifiedMode,
      currency: acct.currency || 'USD',
      source: acct.source || 'IQ_OPTION_UNOFFICIAL',
    };
  }

  async getAssets(ctx?: BrokerAccountContext): Promise<{ assets: BrokerAssetInfo[]; count: number; source: string }> {
    const res = await this.requestConnector<{ assets?: BrokerAssetInfo[]; count?: number; source?: string }>('/assets', {}, ctx);
    const assets = Array.isArray(res.assets) ? res.assets : [];
    return {
      assets,
      count: typeof res.count === 'number' ? res.count : assets.length,
      source: res.source || 'IQ_OPTION_UNOFFICIAL',
    };
  }

  async getQuote(symbol: string, ctx?: BrokerAccountContext): Promise<BrokerQuote> {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    try {
      const res = await this.requestConnector<BrokerQuote>(`/price/${encodeURIComponent(clean)}`, {}, ctx);
      const last = toFiniteNumber(res.last);
      if (last !== null && last > 0) {
        return {
          symbol: res.symbol || clean,
          bid: toFiniteNumber(res.bid),
          ask: toFiniteNumber(res.ask),
          last,
          spread: toFiniteNumber(res.spread),
          time: toFiniteNumber(res.time),
          source: res.source || 'IQ_OPTION_UNOFFICIAL',
          note: res.note,
        };
      }
    } catch (err) {
      const tagged = err as Error & { status?: number; nonRetryable?: boolean };
      const msg = err instanceof Error ? err.message : String(err);
      if (
        tagged?.nonRetryable &&
        tagged.status !== 404 &&
        tagged.status !== 405
      ) {
        throw err;
      }
      if (/IQ_CONNECTOR_URL|unreachable or timed out after/i.test(msg)) {
        throw err;
      }
    }

    const fallback = await this.getCandles(clean, 60, 2, ctx);
    const latest = fallback.candles[fallback.candles.length - 1];
    return {
      symbol: clean,
      bid: null,
      ask: null,
      last: latest ? latest.close : null,
      spread: null,
      time: latest ? latest.time : null,
      source: fallback.source || 'IQ_OPTION_UNOFFICIAL',
      note: 'Derived from latest unofficial 1m candle close.',
    };
  }

  async getCandles(
    symbol: string,
    intervalSeconds = 60,
    count = 100,
    ctx?: BrokerAccountContext
  ): Promise<{ candles: BrokerCandle[]; source: string; note?: string }> {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const safeInterval = Math.max(5, Math.min(86400, Math.round(Number(intervalSeconds) || 60)));
    const safeCount = Math.max(1, Math.min(500, Math.round(Number(count) || 100)));
    const res = await this.requestConnector<{ candles?: BrokerCandle[]; source?: string; note?: string }>(
      '/candles',
      {
        method: 'POST',
        body: JSON.stringify({ symbol: clean, interval: safeInterval, count: safeCount }),
      },
      ctx
    );
    const rawCandles = Array.isArray(res.candles) ? res.candles : [];
    const validCandles: BrokerCandle[] = [];
    for (const c of rawCandles) {
      if (!c || typeof c !== 'object') continue;
      const time = toFiniteNumber(c.time);
      const open = toFiniteNumber(c.open);
      const high = toFiniteNumber(c.high);
      const low = toFiniteNumber(c.low);
      const close = toFiniteNumber(c.close);
      const vol = toFiniteNumber(c.volume);
      if (
        time === null ||
        time <= 0 ||
        open === null ||
        open <= 0 ||
        high === null ||
        high <= 0 ||
        low === null ||
        low <= 0 ||
        close === null ||
        close <= 0
      ) {
        continue;
      }
      validCandles.push({
        time: Math.trunc(time),
        open,
        high,
        low,
        close,
        volume: vol !== null && vol >= 0 ? vol : 0,
      });
    }
    if (validCandles.length === 0) {
      throw new Error(`IQ Option connector returned no valid candlestick data for ${clean}.`);
    }
    return {
      candles: validCandles,
      source: res.source || 'IQ_OPTION_UNOFFICIAL',
      note: res.note,
    };
  }

  async getPositions(ctx?: BrokerAccountContext): Promise<{
    supported: boolean;
    positions: BrokerPosition[];
    source: string;
    note?: string;
  }> {
    const res = await this.requestConnector<{
      supported?: boolean;
      positions?: BrokerPosition[];
      source?: string;
      note?: string;
      mode?: string;
    }>('/positions', {}, ctx);
    const positions = Array.isArray(res.positions) ? res.positions : [];
    return {
      supported: res.supported !== false,
      positions,
      source: res.source || 'IQ_OPTION_UNOFFICIAL',
      note: res.note || `Active IQ Option positions (${res.mode || 'ACTIVE'}).`,
    };
  }

  checkInstrumentCompatibility(
    symbol: string,
    assetClass: BrokerAssetClass,
    orderType: BrokerOrderType = 'BINARY_FIXED_EXPIRY'
  ): InstrumentCompatibilityResult {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (orderType === 'LIMIT') {
      return {
        compatible: false,
        brokerId: this.brokerId,
        symbol: clean,
        mappedSymbol: null,
        assetClass,
        supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
        reason: 'IQ Option supports fixed-expiry binary/digital trades (BINARY_FIXED_EXPIRY), not pending LIMIT orders.',
      };
    }
    if (assetClass === 'COMMODITY') {
      return {
        compatible: false,
        brokerId: this.brokerId,
        symbol: clean,
        mappedSymbol: null,
        assetClass,
        supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
        reason: 'Verify IQ Option open assets first; commodity futures symbols are not directly mapped.',
      };
    }
    return {
      compatible: true,
      brokerId: this.brokerId,
      symbol: clean,
      mappedSymbol: clean,
      assetClass,
      supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
      reason: `IQ Option fixed-expiry execution ready for ${clean} (automatically follows IQ Option's active PRACTICE/REAL mode).`,
    };
  }

  async validateOrder(
    ctx: BrokerAccountContext,
    order: BrokerOrderRequest
  ): Promise<BrokerOrderValidationResult> {
    const clean = (order.mappedSymbol || order.symbol).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    try {
      const liveAcct = await this.getBalance(ctx, true);
      if (liveAcct.accountType !== 'REAL' && liveAcct.accountType !== 'PRACTICE') {
        throw new Error('IQ Option active account mode is UNVERIFIED; live orders are blocked.');
      }
      const liveMode = liveAcct.accountType;
      const liveEnv = liveMode === 'REAL' ? 'real' : 'demo';
      if (liveAcct.balance !== null && order.amount > liveAcct.balance) {
        return {
          valid: false,
          compatible: true,
          environment: liveEnv,
          symbol: order.symbol.toUpperCase(),
          mappedSymbol: clean,
          direction: order.direction,
          orderType: 'BINARY_FIXED_EXPIRY',
          amount: order.amount,
          normalizedVolume: order.amount,
          estimatedMargin: order.amount,
          freeMargin: liveAcct.balance,
          reason: `Insufficient IQ Option ${liveMode} balance ($${liveAcct.balance.toFixed(2)}) for $${order.amount.toFixed(2)} stake.`,
          source: 'IQ_OPTION_LIVE_VERIFIER',
        };
      }
      return {
        valid: true,
        compatible: true,
        environment: liveEnv,
        symbol: order.symbol.toUpperCase(),
        mappedSymbol: clean,
        direction: order.direction,
        orderType: 'BINARY_FIXED_EXPIRY',
        amount: order.amount,
        normalizedVolume: order.amount,
        estimatedMargin: order.amount,
        freeMargin: liveAcct.balance,
        reason: `Verified live IQ Option ${liveMode} account (balance $${(liveAcct.balance ?? 0).toFixed(2)} ${liveAcct.currency}). Order will route strictly to ${liveMode}.`,
        source: 'IQ_OPTION_LIVE_VERIFIER',
      };
    } catch (err) {
      return {
        valid: false,
        compatible: true,
        environment: 'demo',
        symbol: order.symbol.toUpperCase(),
        mappedSymbol: clean,
        direction: order.direction,
        orderType: 'BINARY_FIXED_EXPIRY',
        amount: order.amount,
        normalizedVolume: null,
        estimatedMargin: null,
        freeMargin: null,
        reason: err instanceof Error ? err.message : 'Unable to verify active IQ Option account mode before order.',
        source: 'IQ_OPTION_LIVE_VERIFIER',
      };
    }
  }

  async placeOrder(
    ctx: BrokerAccountContext,
    order: BrokerOrderRequest
  ): Promise<BrokerOrderPlacementResult> {
    const clean = (order.mappedSymbol || order.symbol).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    // Verify the live active mode directly from IQ Option before every single order
    const liveAcct = await this.getBalance(ctx, true);
    if (liveAcct.accountType !== 'REAL' && liveAcct.accountType !== 'PRACTICE') {
      throw new Error('IQ Option active account mode is UNVERIFIED; live orders are blocked.');
    }
    const verifiedLiveMode = liveAcct.accountType;

    const res = await this.requestConnector<{
      accepted?: boolean;
      brokerOrderId?: string;
      status?: 'SUBMITTED' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'CLOSED';
      mappedSymbol?: string;
      filledPrice?: number | null;
      filledUnits?: number | null;
      rawStatus?: string;
      mode?: string;
      accountType?: string;
      modeVerified?: boolean;
      message?: string;
      submittedAt?: string;
    }>(
      '/order',
      {
        method: 'POST',
        body: JSON.stringify({
          symbol: clean,
          direction: order.direction,
          amount: order.amount,
          expirySeconds: order.expirySeconds || 60,
          instrumentType: 'auto',
          expectedMode: verifiedLiveMode,
          idempotencyKey: order.idempotencyKey,
        }),
      },
      ctx
    );

    const confirmedMode = parseVerifiedIqMode(res.mode || res.accountType || verifiedLiveMode, res.modeVerified);
    if (confirmedMode === 'UNVERIFIED') {
      throw new Error('IQ Option connector did not confirm a verified account mode on order response.');
    }
    return {
      accepted: Boolean(res.accepted),
      brokerOrderId: String(res.brokerOrderId || ''),
      status: res.status || 'FILLED',
      mappedSymbol: res.mappedSymbol || clean,
      filledPrice: toFiniteNumber(res.filledPrice),
      filledUnits: toFiniteNumber(res.filledUnits) ?? order.amount,
      rawStatus: res.rawStatus || confirmedMode,
      message: res.message || `Executed on IQ Option (${confirmedMode} mode verified).`,
      submittedAt: res.submittedAt || new Date().toISOString(),
    };
  }

  async getOrderStatus(
    ctx: BrokerAccountContext,
    brokerOrderId: string
  ): Promise<BrokerOrderReconciliationResult> {
    const res = await this.requestConnector<{
      found?: boolean;
      brokerOrderId?: string;
      status?: BrokerOrderReconciliationResult['status'];
      filledPrice?: number | null;
      realizedPnl?: number | null;
      updatedAt?: string;
      note?: string;
    }>(`/orders/${encodeURIComponent(brokerOrderId)}`, {}, ctx);
    return {
      found: Boolean(res.found),
      brokerOrderId: res.brokerOrderId || brokerOrderId,
      status: res.status || 'UNKNOWN',
      filledPrice: toFiniteNumber(res.filledPrice),
      realizedPnl: toFiniteNumber(res.realizedPnl),
      updatedAt: res.updatedAt || new Date().toISOString(),
      note: res.note || 'Checked IQ Option order status.',
    };
  }

  async closePosition(
    ctx: BrokerAccountContext,
    brokerOrderId: string
  ): Promise<{
    closed: boolean;
    brokerOrderId: string;
    status: string;
    realizedPnl: number | null;
    mode?: string | null;
    message: string;
    closedAt?: string | null;
  }> {
    const res = await this.requestConnector<{
      closed?: boolean;
      brokerOrderId?: string;
      status?: string;
      realizedPnl?: number | null;
      mode?: string | null;
      message?: string;
      closedAt?: string | null;
    }>(`/positions/${encodeURIComponent(brokerOrderId)}/close`, { method: 'POST' }, ctx);
    return {
      closed: Boolean(res.closed),
      brokerOrderId: res.brokerOrderId || brokerOrderId,
      status: res.status || (res.closed ? 'CLOSED' : 'OPEN'),
      realizedPnl: toFiniteNumber(res.realizedPnl),
      mode: res.mode || null,
      message: res.message || (res.closed ? 'Closed IQ Option position.' : 'Unable to close IQ Option position.'),
      closedAt: res.closedAt || new Date().toISOString(),
    };
  }

  async getTradeHistory(ctx?: BrokerAccountContext): Promise<BrokerTradeHistoryResult> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured || !cfg.urlValid) {
      return {
        supported: false,
        trades: [],
        note: cfg.warnings[0] || 'IQ_CONNECTOR_URL is not configured.',
      };
    }
    const res = await this.requestConnector<BrokerTradeHistoryResult & { mode?: string }>(
      '/history',
      {},
      ctx
    );
    return {
      supported: Boolean(res.supported),
      trades: Array.isArray(res.trades) ? res.trades : [],
      note: res.note || `Retrieved from IQ Option connector (${res.mode || 'ACTIVE'}).`,
    };
  }
}
