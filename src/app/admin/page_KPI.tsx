// C:\work\o_official\src\app\admin\page.tsx
"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

// ----------------- サンプルデータ -----------------
const salesData = [
  { month: "Jan", sales: 1200 },
  { month: "Feb", sales: 2100 },
  { month: "Mar", sales: 1800 },
  { month: "Apr", sales: 2600 },
  { month: "May", sales: 2300 },
];

const cartAbandonData = [
  { week: "1w", rate: 0.72 },
  { week: "2w", rate: 0.65 },
  { week: "3w", rate: 0.68 },
  { week: "4w", rate: 0.60 },
];

const productData = [
  { name: "T-Shirt", value: 400 },
  { name: "Sneakers", value: 300 },
  { name: "Bag", value: 200 },
  { name: "Cap", value: 100 },
];

const COLORS = ["#0088FE", "#FFBB28", "#FF8042", "#00C49F"];

// ----------------- KPIカード -----------------
const KPICard = ({
  title,
  value,
  change,
}: {
  title: string;
  value: string;
  change: number;
}) => {
  const isPositive = change >= 0;
  return (
    <Card className="flex-1">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {isPositive ? (
          <ArrowUpRight className="h-4 w-4 text-green-500" />
        ) : (
          <ArrowDownRight className="h-4 w-4 text-red-500" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p
          className={`text-xs mt-1 ${
            isPositive ? "text-green-500" : "text-red-500"
          }`}
        >
          {isPositive ? "+" : ""}
          {change}% vs last period
        </p>
      </CardContent>
    </Card>
  );
};

// ----------------- 管理ダッシュボード -----------------
export default function AdminPage() {
  const [lang, setLang] = useState<"ja" | "en">("ja");

  const t = (key: string) => {
    const dict: Record<string, { ja: string; en: string }> = {
      uv: { ja: "訪問者数（UV）", en: "Unique Visitors" },
      cvr: { ja: "コンバージョン率（CVR）", en: "Conversion Rate" },
      orders: { ja: "注文数", en: "Orders" },
      revenue: { ja: "売上金額", en: "Revenue" },
      aov: { ja: "平均注文単価（AOV）", en: "Avg Order Value" },
      cart: { ja: "カート放棄率推移", en: "Cart Abandon Rate" },
      salesTrend: { ja: "売上推移", en: "Sales Trend" },
      products: { ja: "人気商品", en: "Top Products" },
    };
    return dict[key] ? dict[key][lang] : key;
  };

  return (
    <div className="p-6 space-y-6">
      {/* 言語切替 */}
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => setLang(lang === "ja" ? "en" : "ja")}>
          {lang === "ja" ? "English" : "日本語"}
        </Button>
      </div>

      {/* KPIカード */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard title={t("uv")} value="15,200" change={5} />
        <KPICard title={t("cvr")} value="2.4%" change={-0.3} />
        <KPICard title={t("orders")} value="1,120" change={8} />
        <KPICard title={t("revenue")} value="¥2,450,000" change={12} />
        <KPICard title={t("aov")} value="¥3,200" change={3} />
      </div>

      {/* 売上推移 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("salesTrend")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={salesData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="sales" stroke="#8884d8" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* カート放棄率推移 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("cart")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={cartAbandonData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="week" />
              <YAxis tickFormatter={(v: number) => `${v * 100}%`} />
              <Tooltip formatter={(value: number) => `${(value * 100).toFixed(1)}%`} />
              <Legend />
              <Bar dataKey="rate" fill="#FF8042" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* 人気商品 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("products")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={productData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label
              >
                {productData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
