export interface ISlackNotifier {
  notifyError(err: Error, context: string): Promise<void>;
  notifyPositionOpened(payload: any): Promise<void>;
  notifyPositionClosed(payload: any): Promise<void>;
  notifyOrderPlaced?(payload: any): Promise<void>;
  notifyFill?(payload: any): Promise<void>;
  notifySignalDetected?(payload: any): Promise<void>;
}
