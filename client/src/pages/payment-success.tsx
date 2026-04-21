import { CheckCircle, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PaymentSuccess() {
  const whatsappNumber = import.meta.env.VITE_WHATSAPP_NUMBER || "27600000000";

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="flex justify-center">
          <CheckCircle className="w-20 h-20 text-green-400" />
        </div>

        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-white">Payment confirmed!</h1>
          <p className="text-gray-400 text-lg">
            Welcome to KamLife Coach. Your subscription is now active.
          </p>
        </div>

        <div className="bg-gray-900 rounded-xl p-6 text-left space-y-3 border border-gray-800">
          <p className="text-white font-semibold">What happens next:</p>
          <ul className="text-gray-400 space-y-2 text-sm">
            <li>✅ Coach K will send your Day 1 workout on WhatsApp now</li>
            <li>✅ Morning check-ins start tomorrow at 6am</li>
            <li>✅ Log meals, steps and workouts via WhatsApp anytime</li>
            <li>✅ Coach K checks in morning and evening every day</li>
          </ul>
        </div>

        <p className="text-gray-500 text-sm">
          If you don't receive a WhatsApp message within 5 minutes, message Coach K directly.
        </p>

        <Button
          className="w-full bg-green-600 hover:bg-green-500 text-white h-12 text-base font-semibold"
          onClick={() => {
            window.open(`https://wa.me/${whatsappNumber.replace(/\D/g, "")}?text=I+just+paid+and+I'm+ready+to+start!`, "_blank");
          }}
        >
          <MessageCircle className="w-5 h-5 mr-2" />
          Open WhatsApp with Coach K
        </Button>
      </div>
    </div>
  );
}
