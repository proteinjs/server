export abstract class FeatureFlag {
  protected featureName: string;
  protected isEnabled: boolean;

  constructor(featureName: string, isEnabled: boolean) {
    this.featureName = featureName;
    this.isEnabled = isEnabled;
  }

  async getFeatureFlag(): Promise<boolean> {
    return Promise.resolve(this.isEnabled);
  }

  async setFeatureFlag(isEnabled: boolean): Promise<void> {
    this.isEnabled = isEnabled;
    return Promise.resolve();
  }
}
