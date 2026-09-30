import type { Metadata } from "next";
import HomeScreen from "@/components/home/HomeScreen";

export const metadata: Metadata = {
  title: "Home",
};

export default function HomePage() {
  return (
    <main className="app-shell">
      <HomeScreen />
    </main>
  );
}
