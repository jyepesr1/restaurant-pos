import { createInterface } from 'node:readline'

// Pedir un secreto en la terminal sin mostrarlo (la cadena de conexión, el token de
// administración): así no queda en el historial de la terminal ni en la pantalla.

export function pedirSecreto(pregunta: string): Promise<string> {
  return new Promise((resolver) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const escribir = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput
    ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      // Solo se muestra la pregunta; lo que se escribe no.
      if (s.includes(pregunta)) escribir.call(rl, s)
    }
    rl.question(pregunta, (respuesta) => {
      rl.close()
      process.stdout.write('\n')
      resolver(respuesta.trim())
    })
  })
}

/** Una variable de entorno o, si no está, preguntarla sin mostrarla. */
export async function secreto(variable: string, pregunta: string): Promise<string> {
  const valor = process.env[variable]?.trim() || (await pedirSecreto(pregunta))
  if (!valor) {
    console.error('No escribiste nada. No se hizo ningún cambio.')
    process.exit(1)
  }
  return valor
}
