import type { BrokerAdapter, BrokerCapabilities, BrokerId } from './types.ts';
import { IQOptionAdapter } from './iqOption.ts';
import { MetaTrader5Adapter } from './mt5.ts';

export interface BrokerCatalogEntry {
  id: BrokerId;
  name: string;
  apiType: BrokerCapabilities['apiType'];
  isOfficialApi: boolean;
  isPreparedAdapterOnly: boolean;
  status: 'INTEGRATED_READONLY' | 'OFFICIAL_SANDBOX_API' | 'PREPARED_BRIDGE' | 'PLANNED';
  description: string;
  realExecutionEnabled: boolean;
  capabilities: BrokerCapabilities;
}

export class BrokerRegistry {
  private readonly adapters = new Map<BrokerId, BrokerAdapter>();

  constructor() {
    this.register(new MetaTrader5Adapter());
    this.register(new IQOptionAdapter());
  }

  register(adapter: BrokerAdapter) {
    this.adapters.set(adapter.brokerId, adapter);
  }

  get(brokerId: string): BrokerAdapter | undefined {
    return this.adapters.get(brokerId as BrokerId);
  }

  listAllAdapters(): BrokerAdapter[] {
    return Array.from(this.adapters.values());
  }

  async listCatalog(): Promise<BrokerCatalogEntry[]> {
    const adapters = this.listAllAdapters();
    const capsList = await Promise.all(adapters.map((a) => a.getCapabilities()));

    return capsList.map((caps) => {
      let status: BrokerCatalogEntry['status'] = 'PREPARED_BRIDGE';
      if (caps.brokerId === 'iq_option') {
        status = 'INTEGRATED_READONLY';
      } else if (caps.brokerId === 'mt5') {
        status = caps.connectorConfigured ? 'OFFICIAL_SANDBOX_API' : 'PREPARED_BRIDGE';
      }

      return {
        id: caps.brokerId,
        name: caps.broker,
        apiType: caps.apiType,
        isOfficialApi: caps.isOfficialApi,
        isPreparedAdapterOnly: caps.isPreparedAdapterOnly,
        status,
        description: caps.message,
        realExecutionEnabled: Boolean(caps.realAccountSupported && caps.liveOrderPlacementSupported),
        capabilities: caps,
      };
    });
  }
}
