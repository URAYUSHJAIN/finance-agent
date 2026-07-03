// Next 14 metadata route → generates /robots.txt
const SITE_URL = "https://finance-categorizer-agent.vercel.app";

export default function robots() {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
