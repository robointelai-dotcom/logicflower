import axios from 'axios';
import type { ConnectorRequest, ConnectorResponse, ConnectorTransport } from './types';
import { withRetry } from '../retry';

export class AxiosConnectorTransport implements ConnectorTransport {
  async request<T = any>(request: ConnectorRequest): Promise<ConnectorResponse<T>> {
    const attempts = request.method === 'GET' ? 4 : 1;
    return withRetry(async () => {
      const response = await axios.request<T>({
        method: request.method,
        url: request.url,
        headers: request.headers,
        params: request.params,
        data: request.data,
        timeout: Math.min(60_000, Math.max(1_000, request.timeoutMs || 20_000)),
        maxRedirects: 0,
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
        httpsAgent: request.httpsAgent,
        validateStatus: status => status >= 200 && status < 300,
      });
      return { status: response.status, data: response.data, headers: response.headers as any };
    }, { attempts, baseDelayMs: 300, maxDelayMs: 15_000 });
  }
}
