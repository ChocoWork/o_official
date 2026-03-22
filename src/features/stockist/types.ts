export type StockistType = 'FLAGSHIP STORE' | 'STORE' | 'SELECT SHOP';

export type PublicStockist = {
  type: StockistType;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
};