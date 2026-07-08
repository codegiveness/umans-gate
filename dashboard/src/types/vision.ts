export interface VisionCallRecord {
  id: number;
  captureId: number | null;
  model: string;
  target: string;
  imageSize: number;
  imageHash: string | null;
  status: string;
  httpStatus: number | null;
  latencyMs: number;
  description: string;
  error: string | null;
  timestamp: number;
}
