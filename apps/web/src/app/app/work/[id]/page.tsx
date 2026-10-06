"use client";

import { useParams } from "next/navigation";
import { TaskView } from "@/components/work/task-view";

export default function WorkTaskPage() {
  const { id } = useParams<{ id: string }>();
  return <TaskView key={id} taskId={id} />;
}
