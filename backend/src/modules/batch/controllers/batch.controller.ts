import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BatchModule, BatchStatus, ItemStatus } from '@prisma/client';
import { ValidationError } from '../../../common/exceptions/app-error.js';
import { env } from '../../../common/config/env.js';
import { validateUploadFile } from '../validators/file-validator.js';
import { batchService } from '../services/batch.service.js';
import type { DownloadType } from '../dto/types.js';

function parseModule(raw: string): BatchModule {
  const upper = raw.toUpperCase().replace(/-/g, '_');
  if (upper === 'INVOICE_GENERATION' || upper === 'INVOICE_CHARGE') {
    return upper;
  }
  throw new ValidationError('Invalid module. Use invoice-generation or invoice-charge');
}

export class BatchController {
  async upload(request: FastifyRequest, reply: FastifyReply) {
    const { module: moduleParam } = request.params as { module: string };
    const module = parseModule(moduleParam);

    await batchService.assertNoOpenBatch(module);

    const file = await request.file();
    if (!file) {
      throw new ValidationError('File is required');
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += chunk.length;
      if (size > env.uploadMaxBytes) {
        throw new ValidationError(`File exceeds max size ${env.UPLOAD_MAX_SIZE}`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const validation = await validateUploadFile(
      buffer,
      file.filename,
      file.mimetype,
    );

    const { uploadToken, summary } = batchService.storeValidation(
      module,
      request.user.email,
      validation,
    );

    return reply.send({ uploadToken, ...summary });
  }

  async confirm(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as { uploadToken?: string };
    if (!body?.uploadToken) {
      throw new ValidationError('uploadToken is required');
    }
    const batch = await batchService.confirmUpload(body.uploadToken);
    return reply.code(201).send(batch);
  }

  async list(request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as {
      module?: string;
      status?: string;
      page?: string;
      pageSize?: string;
    };
    const result = await batchService.list({
      module: query.module ? parseModule(query.module) : undefined,
      status: query.status as BatchStatus | undefined,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
    });
    return reply.send(result);
  }

  async getById(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const result = await batchService.getById(BigInt(id));
    return reply.send(result);
  }

  async getItems(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const query = request.query as {
      status?: string;
      page?: string;
      pageSize?: string;
    };
    const result = await batchService.getItems(BigInt(id), {
      status: query.status as ItemStatus | undefined,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 50,
    });
    return reply.send(result);
  }

  async getLogs(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const query = request.query as { page?: string; pageSize?: string };
    const result = await batchService.getLogs(
      BigInt(id),
      query.page ? Number(query.page) : 1,
      query.pageSize ? Number(query.pageSize) : 50,
    );
    return reply.send(result);
  }

  async retryFailed(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const result = await batchService.retryFailed(BigInt(id), request.user.email);
    return reply.send(result);
  }

  async retryDlq(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const result = await batchService.retryDlq(BigInt(id), request.user.email);
    return reply.send(result);
  }

  async cancel(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const result = await batchService.cancel(BigInt(id), request.user.email);
    return reply.send(result);
  }

  async download(request: FastifyRequest, reply: FastifyReply) {
    const { id, type } = request.params as { id: string; type: DownloadType };
    const result = await batchService.download(BigInt(id), type);
    return reply.send(result);
  }
}

export const batchController = new BatchController();
