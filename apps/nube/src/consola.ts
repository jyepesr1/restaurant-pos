import { createInterface } from 'node:readline'

// Pedir un secreto en la terminal sin mostrarlo (la cadena de conexión, el token de
// administración): así no queda en el historial de la terminal ni en la pantalla.

export function pedirSecreto(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput
    ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      // Solo se muestra la pregunta; lo que se escribe no.
      if (s.includes(question)) write.call(rl, s)
    }
    rl.question(question, (response) => {
      rl.close()
      process.stdout.write('\n')
      resolve(response.trim())
    })
  })
}

/** Una variable de entorno o, si no está, preguntarla sin mostrarla. */
export async function secret(variable: string, question: string): Promise<string> {
  const value = process.env[variable]?.trim() || (await pedirSecreto(question))
  if (!value) {
    console.error('No escribiste nada. No se hizo ningún cambio.')
    process.exit(1)
  }
  return value
}
