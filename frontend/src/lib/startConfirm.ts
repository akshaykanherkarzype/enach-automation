import { formatCount } from './batch';

export interface StartConfirmCopy {
  title: string;
  body: string;
  confirm: string;
}

export function startConfirmCopy(
  module: 'invoice-generation' | 'invoice-charge',
  customers: number,
  filename: string,
): StartConfirmCopy {
  const count = formatCount(customers);
  const file = filename.trim() || 'this file';
  if (module === 'invoice-charge') {
    return {
      title: 'Start invoice charge?',
      body: `This starts the invoice charge process for ${count} customers in ${file}. Nothing is charged until you confirm.`,
      confirm: 'Start invoice charge',
    };
  }
  return {
    title: 'Start invoice generation?',
    body: `This starts the invoice generation process for ${count} customers in ${file}. Nothing is created until you confirm.`,
    confirm: 'Start invoice generation',
  };
}
