// Next 14 metadata route → generates /sitemap.xml
const SITE_URL = "https://finance-categorizer-agent.vercel.app";

export default function sitemap() {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
