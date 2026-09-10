import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "InventoryLens",
  description: "Visual search across your inventory — import, identify, confirm.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} antialiased`}>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 min-w-0 px-8 py-8 lg:px-12">{children}</main>
        </div>
      </body>
    </html>
  );
}
