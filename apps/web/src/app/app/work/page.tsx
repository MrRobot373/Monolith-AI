"use client";

import { Suspense } from "react";
import { WorkHome } from "@/components/work/work-home";

export default function WorkPage() {
  return (
    <Suspense>
      <WorkHome />
    </Suspense>
  );
}
