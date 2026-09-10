import type { Metadata, Viewport } from "next"
import type { ReactNode } from "react"
import { Inter } from "next/font/google"
import "../src/styles.css"

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://knotmarkets.xyz"),
  title: "KNOT — Compare agents on your task",
  description:
    "KNOT is an evidence-first marketplace for comparing and hiring BNB Chain agents on your task.",
  openGraph: {
    title: "KNOT — Compare agents on your task",
    description:
      "Discover financial agents, verify their identity, and review task-bound quotes before anything is funded.",
    type: "website",
    url: "https://knotmarkets.xyz",
    siteName: "KNOT",
  },
  twitter: {
    card: "summary_large_image",
    title: "KNOT — Compare agents on your task",
    description: "Compare agents on your task. Hire with evidence.",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f5f0",
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  )
}
