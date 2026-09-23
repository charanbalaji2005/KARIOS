'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SqlPage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;
  const router = useRouter();

  useEffect(() => {
    router.replace(`/project/${ref}/editor`);
  }, [ref, router]);

  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted">
      Redirecting to table editor...
    </div>
  );
}
