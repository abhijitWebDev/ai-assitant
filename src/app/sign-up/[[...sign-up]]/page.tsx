import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { Backdrop } from "@/components/backdrop";

export default function SignUpPage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12">
      <Backdrop />
      <Link href="/" className="font-onest text-xl font-medium tracking-tight transition-colors hover:text-brand">
        Research Desk
      </Link>
      <SignUp />
    </div>
  );
}
