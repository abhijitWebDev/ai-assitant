'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A panel that slides in from an edge: a phone menu, filters, a detail
 * view. Radix Dialog underneath, so focus is trapped and Escape closes it.
 * `side` picks the edge; the slide is skipped for reduced motion.
 */
const Drawer = DialogPrimitive.Root
const DrawerTrigger = DialogPrimitive.Trigger
const DrawerClose = DialogPrimitive.Close

const sides = {
  right: 'inset-y-0 right-0 h-full w-[min(24rem,90vw)] border-l motion-safe:data-[state=open]:animate-[chai-drawer-right_0.25s_ease-out]',
  left: 'inset-y-0 left-0 h-full w-[min(24rem,90vw)] border-r motion-safe:data-[state=open]:animate-[chai-drawer-left_0.25s_ease-out]',
  bottom: 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t motion-safe:data-[state=open]:animate-[chai-drawer-bottom_0.25s_ease-out]',
}

function DrawerContent({
  side = 'right',
  title,
  description,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { side?: keyof typeof sides; title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[6px] motion-safe:data-[state=open]:animate-chai-fade" />
      <DialogPrimitive.Content
        data-slot="drawer"
        className={cn('fixed z-[100] flex flex-col gap-4 overflow-y-auto border-card-edge-hover bg-card p-6 text-card-foreground outline-none', sides[side], className)}
        {...props}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="font-montserrat text-lg font-semibold">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export { Drawer, DrawerClose, DrawerContent, DrawerTrigger }
