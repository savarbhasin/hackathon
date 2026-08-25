import type { Metadata } from "next";
import { Archivo, Manrope } from "next/font/google";
import { ConsoleShell } from "@/components/console-header";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "The Squad | Agent fleet console",
  description:
    "Supervise agent tasks, scheduled work, saved documents, and actions that need human approval.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-deck font-sans text-ink selection:bg-signal selection:text-deck">
        <ConsoleShell>{children}</ConsoleShell>
      </body>
    </html>
  );
}
