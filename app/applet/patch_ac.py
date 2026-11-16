with open("novatrade-ai/server/src/androidCompanion.ts", "r") as f:
    ac = f.read()

target = """    if (admin && userId !== 'local-preview') {
      await admin
        .from('android_devices')
        .update({
          permissions: dev.permissions,
          target_packages: dev.targetPackages,
          status: dev.status,
          last_app_package: dev.lastAppPackage,
          updated_at: dev.updatedAt,
        })
        .eq('id', dev.id)
        .eq('user_id', userId);
    }
    return toPublicDevice(dev);
  }"""

methods = """

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const store = this.getOrInitStore(userId);
    const dev = store.devices.find((d) => d.id === deviceId && d.status !== 'REVOKED');
    if (!dev) return false;
    dev.status = 'REVOKED';
    dev.updatedAt = new Date().toISOString();
    this.saveStore(userId);

    const admin = getSupabaseAdmin();
    if (admin && userId !== 'local-preview') {
      await admin
        .from('android_devices')
        .update({
          status: 'REVOKED',
          updated_at: dev.updatedAt,
        })
        .eq('id', deviceId)
        .eq('user_id', userId);
    }
    return true;
  }

  listAnalyses(userId: string): AndroidScreenAnalysisRecord[] {
    const store = this.getOrInitStore(userId);
    return store.analyses;
  }

  listActions(userId: string): AndroidActionQueueItem[] {
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    return store.actions;
  }"""

if "revokeDevice" not in ac:
    pos = ac.find(target)
    if pos != -1:
        ac = ac[:pos + len(target)] + methods + ac[pos + len(target):]
        with open("novatrade-ai/server/src/androidCompanion.ts", "w") as f:
            f.write(ac)
        print("Successfully patched androidCompanion.ts with revokeDevice, listAnalyses, listActions")
    else:
        print("Error: target not found in androidCompanion.ts")
else:
    print("revokeDevice already present")
