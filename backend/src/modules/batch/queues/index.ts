/** Queue name helpers re-exported for module consumers. */
export {
  queueForModule,
  retryQueueForModule,
  dlqForModule,
  publishBatch,
  publishToQueue,
} from '../../../infrastructure/rabbitmq/client.js';
