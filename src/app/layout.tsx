import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claude Sessions",
  description: "Browse and manage Claude Code sessions",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");document.documentElement.className=t==="light"?"":"dark"}catch(e){document.documentElement.className="dark"}})()`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){window.addEventListener("error",function(e){if(e.message&&(e.message.indexOf("Loading chunk")!==-1||e.message.indexOf("Failed to fetch dynamically imported module")!==-1)){var k="__chunk_reload",v=sessionStorage.getItem(k);if(!v||Date.now()-Number(v)>10000){sessionStorage.setItem(k,String(Date.now()));window.location.reload()}}})})()`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
