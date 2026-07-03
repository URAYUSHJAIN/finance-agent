import "./globals.css";

// Placeholder production URL — swap for your real domain when you deploy.
const SITE_URL = "https://finance-categorizer-agent.vercel.app";

const DESCRIPTION =
  "Free, privacy-first tool that categorizes UPI and bank transactions entirely in your browser. " +
  "No AI API, no upload, no sign-up — paste text or drop a CSV / XLSX / PDF and get categorized, " +
  "totalled results you can export as CSV.";

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Finance Categorizer Agent — Private, Rule-Based UPI & Bank Statement Categorizer",
    template: "%s · Finance Categorizer Agent",
  },
  description: DESCRIPTION,
  applicationName: "Finance Categorizer Agent",
  keywords: [
    "UPI categorizer",
    "bank statement categorizer",
    "expense categorizer",
    "transaction categorization",
    "personal finance tool",
    "privacy-first finance",
    "client-side finance app",
    "no AI API",
    "CSV bank statement parser",
    "PDF statement parser",
    "budgeting tool",
    "India UPI",
  ],
  authors: [{ name: "Ayush Jain", url: "https://urayushjain.tech" }],
  creator: "Ayush Jain",
  publisher: "Ayush Jain",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Finance Categorizer Agent",
    title: "Finance Categorizer Agent — Private UPI & Bank Statement Categorizer",
    description: DESCRIPTION,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Finance Categorizer Agent — rule-based, no AI API, runs in your browser",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Finance Categorizer Agent",
    description: DESCRIPTION,
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
};

export const viewport = {
  themeColor: "#0e1113",
};

// SoftwareApplication structured data so search engines understand this is a
// free, client-side finance tool.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Finance Categorizer Agent",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Any (runs in a web browser)",
  url: SITE_URL,
  description: DESCRIPTION,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "Ayush Jain", url: "https://urayushjain.tech" },
  featureList: [
    "Categorize UPI and bank transactions with a transparent keyword rule engine",
    "Paste text, or upload CSV / XLSX / PDF statements",
    "Runs fully client-side — no data leaves the browser",
    "Per-row confidence with a review-and-fix workflow",
    "Month-over-month spending comparison",
    "Export categorized transactions as CSV",
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="true" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
