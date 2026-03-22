import { PublicStockist } from '@/features/stockist/types';

export const STOCKIST_MAP_EMBED_URL =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3241.2479707857677!2d139.71433831525895!3d35.66572098019819!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x60188b835e2c0d0f%3A0x3c6c8e8e8e8e8e8e!2z5p2x5Lqs6YO95riv5Yy65Y2X6Z2S5bGx!5e0!3m2!1sja!2sjp!4v1234567890123!5m2!1sja!2sjp';

export const PUBLIC_STOCKISTS: PublicStockist[] = [
  {
    type: 'FLAGSHIP STORE',
    name: 'Le Fil des Heures Aoyama',
    address: '東京都港区南青山3-14-15',
    phone: '03-1234-5678',
    time: '11:00 - 20:00',
    holiday: '水曜定休',
  },
  {
    type: 'STORE',
    name: 'Le Fil des Heures Ginza',
    address: '東京都中央区銀座6-10-1',
    phone: '03-2345-6789',
    time: '11:00 - 20:00',
    holiday: '不定休',
  },
  {
    type: 'STORE',
    name: 'Le Fil des Heures Osaka',
    address: '大阪府大阪市北区梅田2-5-25',
    phone: '06-3456-7890',
    time: '11:00 - 20:00',
    holiday: '水曜定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Maison de Mode Tokyo',
    address: '東京都渋谷区神宮前5-10-1',
    phone: '03-4567-8901',
    time: '12:00 - 20:00',
    holiday: '月曜定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Atelier Blanc Kyoto',
    address: '京都府京都市中京区烏丸通三条上ル',
    phone: '075-567-8901',
    time: '11:00 - 19:00',
    holiday: '火曜定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Minimal Store Fukuoka',
    address: '福岡県福岡市中央区天神2-8-34',
    phone: '092-678-9012',
    time: '11:00 - 20:00',
    holiday: '不定休',
  },
];

export const HOME_PUBLIC_STOCKISTS: PublicStockist[] = [
  {
    type: 'FLAGSHIP STORE',
    name: 'Le Fil des Heures Aoyama',
    address: '東京都港区南青山3-14-8',
    phone: '03-1234-5678',
    time: '11:00 - 20:00',
    holiday: '水曜定休',
  },
  {
    type: 'STORE',
    name: 'Le Fil des Heures Ginza',
    address: '東京都中央区銀座6-10-1',
    phone: '03-2345-6789',
    time: '11:00 - 20:00',
    holiday: '不定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Le Fil des Heures Kyoto',
    address: '京都府京都市中京区烏丸通三条上ル',
    phone: '075-123-4567',
    time: '11:00 - 19:00',
    holiday: '水曜定休',
  },
  {
    type: 'STORE',
    name: 'Le Fil des Heures Osaka',
    address: '大阪府大阪市北区梅田2-5-25',
    phone: '06-1234-5678',
    time: '11:00 - 20:00',
    holiday: '不定休',
  },
];

export function getPublicStockists(): PublicStockist[] {
  return PUBLIC_STOCKISTS;
}