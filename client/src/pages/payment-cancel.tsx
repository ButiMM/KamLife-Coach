import { XCircle, MessageCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PaymentCancel() {
  // Same rule as the landing CTA: the real business number is the default, never a placeholder.
  const whatsappNumber = import.meta.env.VITE_WHATSAPP_NUMBER || "27749190460";

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="flex justify-center">
          <XCircle className="w-20 h-20 text-red-400" />
        </div>

        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-white">Payment cancelled</h1>
          <p className="text-gray-400 text-lg">
            No payment was taken. Your spot is still available.
          </p>
        </div>

        <div className="bg-gray-900 rounded-xl p-6 text-left space-y-3 border border-gray-800">
          <p className="text-white font-semibold">Why join KamLife Coach?</p>
          <ul className="text-gray-400 space-y-2 text-sm">
            <li>🔥 Personalised workouts for your goal and equipment</li>
            <li>📸 Meal photo logging — just take a photo and we track it</li>
            <li>🚶 Step tracking + daily accountability</li>
            <li>💬 Coach K available 24/7 on WhatsApp</li>
            <li>🇿🇦 Built for South Africans — budget meals, home workouts, load shedding proof</li>
          </ul>
        </div>

        <p className="text-gray-500 text-sm">
          Only R149/month, with a 14-day money-back guarantee. Cancel anytime. No contracts.
        </p>

        <div className="space-y-3">
          <Button
            className="w-full bg-green-600 hover:bg-green-500 text-white h-12 text-base font-semibold"
            onClick={() => window.history.back()}
          >
            <RotateCcw className="w-5 h-5 mr-2" />
            Try payment again
          </Button>

          <Button
            variant="outline"
            className="w-full border-gray-700 text-gray-300 hover:bg-gray-800 h-12 text-base"
            onClick={() => {
              window.open(`https://wa.me/${whatsappNumber.replace(/\D/g, "")}?text=I+had+trouble+paying.+Can+you+help?`, "_blank");
            }}
          >
            <MessageCircle className="w-5 h-5 mr-2" />
            Message Coach K for help
          </Button>
        </div>
      </div>
    </div>
  );
}
